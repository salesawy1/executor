/**
 * TradingView Puppeteer Client
 * 
 * Automates TradingView paper trading via browser automation.
 * - Logs in with credentials from .env
 * - Navigates to chart URL
 * - Connects to paper trading broker
 * - Places market orders with TP/SL
 */

import puppeteer, { Browser, Page } from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { IS_ALT, IS_PROD } from './index.js';
import { SectionLogger, createSectionLogger } from './logger.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Coinbase contract parameters for auto-sizing
const COINBASE_CONTRACT_SIZE = 0.1; // ETH per contract
const COINBASE_LEVERAGE = 10;       // Default leverage

export interface TradingViewConfig {
    email: string;
    password: string;
    chartUrl: string;
    headless?: boolean;
}

export interface OrderParams {
    symbol?: string;
    direction: "LONG" | "SHORT";
    quantity: number;
    stopLoss?: number;
    takeProfit?: number;
}

export interface ExecutionDetails {
    symbol: string;
    side: "LONG" | "SHORT";
    entryPrice: number;
    quantity: number;
    marginUsed: number;
    fee?: number;
    takeProfit?: number;
    stopLoss?: number;
    timestamp: string;
}

export interface ExecutionResult {
    success: boolean;
    error?: string;
    executionDetails?: ExecutionDetails;
    executionLogs?: string[];
}

export class TradingViewClient {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private config: TradingViewConfig;
    private isLoggedIn: boolean = false;
    private isBrokerConnected: boolean = false;

    constructor(config: TradingViewConfig) {
        this.config = config;
    }

    /**
     * Initialize browser and login to TradingView
     */
    async initialize(): Promise<void> {
        console.log(`🚀 Launching browser (${IS_ALT ? 'ALT' : 'MAIN'} profile)...`);

        // Use separate Chrome profiles for main vs alt accounts
        // This isolates all cookies, localStorage, cache - no logout needed when switching
        const profileDir = path.join(__dirname, "..", ".chrome-profiles", IS_ALT ? "alt" : "main");

        this.browser = await puppeteer.launch({
            headless: this.config.headless ?? false, // Default to visible for debugging
            userDataDir: profileDir, // Separate profile per account
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--window-size=1920,1080",
            ],
            defaultViewport: {
                width: 1920,
                height: 1080,
            },
        });

        // Get the existing page (Puppeteer opens with one blank page)
        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();

        // Try to load existing session (cookies + localStorage)
        const sessionData = this.loadSession();
        if (sessionData) {
            console.log("📂 Found existing session, restoring...");
            await this.page.setCookie(...sessionData.cookies);

            // Navigate to TradingView first to set localStorage on same origin
            await this.page.goto('https://www.tradingview.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Restore localStorage if present
            if (sessionData.localStorage) {
                await this.page.evaluate((data) => {
                    for (const [key, value] of Object.entries(data)) {
                        window.localStorage.setItem(key, value as string);
                    }
                }, sessionData.localStorage);
                console.log("   ✅ Restored localStorage");
            }
        }

        // Set user agent to avoid detection
        await this.page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        await this.login();
        await this.navigateToChart();
        await this.connectPaperTradingBroker();
    }

    /**
     * Load session from disk
     */
    private loadSession(): { cookies: any[]; localStorage?: Record<string, string> } | null {
        try {
            // Session file path (stored in executor directory)
            const SESSION_PATH = path.join(__dirname, "..", IS_ALT ? "tradingview-alt-session.json" : "tradingview-session.json");

            if (fs.existsSync(SESSION_PATH)) {
                const data = fs.readFileSync(SESSION_PATH, "utf-8");
                const session = JSON.parse(data);
                console.log(` ${IS_ALT ? "Alt" : "Main"} Session file found (saved: ${session.savedAt})`);
                return session;
            }
        } catch (e) {
            console.log("   Could not load session file");
        }
        return null;
    }

    /**
     * Save session to disk (cookies + localStorage)
     */
    private async saveSession(): Promise<void> {
        if (!this.page) return;
        // Session file path (stored in executor directory)
        const SESSION_PATH = path.join(__dirname, "..", IS_ALT ? "tradingview-alt-session.json" : "tradingview-session.json");

        try {
            const cookies = await this.page.cookies();

            // Also save localStorage (contains auth tokens!)
            const localStorageData = await this.page.evaluate(() => {
                const data: Record<string, string> = {};
                for (let i = 0; i < window.localStorage.length; i++) {
                    const key = window.localStorage.key(i);
                    if (key) {
                        data[key] = window.localStorage.getItem(key) || '';
                    }
                }
                return data;
            });

            const session = {
                cookies,
                localStorage: localStorageData,
                savedAt: new Date().toISOString()
            };
            fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
            console.log(` ${IS_ALT ? "Alt" : "Main"} Session saved to disk (cookies + localStorage)`);
        } catch (e) {
            console.log(` ${IS_ALT ? "Alt" : "Main"} Could not save session:`, e);
        }
    }

    /**
     * Check if already logged in by looking for sessionid cookie.
     * This is much faster than navigating to a page and checking UI elements.
     */
    private async checkIfLoggedIn(): Promise<boolean> {
        if (!this.page) return false;

        try {
            // Get all cookies for tradingview.com
            const cookies = await this.page.cookies("https://www.tradingview.com");

            // Look for the sessionid cookie - this is the primary auth cookie
            const sessionCookie = cookies.find(c => c.name === "sessionid");

            if (sessionCookie && sessionCookie.value) {
                // Check if session has expired
                const now = Date.now() / 1000; // Convert to seconds (cookie expires is in seconds)
                if (sessionCookie.expires && sessionCookie.expires > now) {
                    console.log("✅ Already logged in (sessionid cookie found)!");
                    return true;
                } else if (sessionCookie.expires && sessionCookie.expires <= now) {
                    console.log("   Session cookie expired");
                    return false;
                }
                // If no expires field, assume it's valid
                console.log("✅ Already logged in (sessionid cookie found)!");
                return true;
            }

            console.log("   No sessionid cookie found");
            return false;
        } catch (e) {
            console.log("   Error checking login status via cookies");
            return false;
        }
    }

    /**
     * Login to TradingView
     */
    private async login(): Promise<void> {
        if (!this.page) throw new Error("Browser not initialized");

        console.log("🔐 Checking TradingView login status...");

        // First check if we're already logged in from saved session
        const alreadyLoggedIn = await this.checkIfLoggedIn();
        if (alreadyLoggedIn) {
            this.isLoggedIn = true;
            return;
        }

        console.log("   Session expired or not found, performing fresh login...");

        // Navigate to TradingView login (we're already there from checkIfLoggedIn, but ensure we're on signin)
        const currentUrl = this.page.url();
        if (!currentUrl.includes('/accounts/signin')) {
            await this.page.goto("https://www.tradingview.com/accounts/signin/", {
                waitUntil: "networkidle2",
                timeout: 30000,
            });
            await this.delay(2000);
        }

        // Click "Email" button to show email login form
        try {
            await this.page.waitForSelector('button[name="Email"]', { timeout: 10000 });
            await this.page.click('button[name="Email"]');
            await this.delay(500);
        } catch (e) {
            console.log("   Email button not found, trying alternative selectors...");
            // Try class-based selector as fallback
            const emailButton = await this.page.$('.emailButton-nKAw8Hvt');
            if (emailButton) await emailButton.click();
        }

        // Enter email
        console.log("   Entering email...");
        await this.page.waitForSelector('#id_username', { timeout: 10000 });
        const emailInput = await this.page.$('#id_username');
        if (emailInput) {
            await emailInput.click();
            await emailInput.type(this.config.email, { delay: 50 });
        }

        // Enter password
        console.log("   Entering password...");
        await this.page.waitForSelector('#id_password', { timeout: 10000 });
        const passwordInput = await this.page.$('#id_password');
        if (passwordInput) {
            await passwordInput.click();
            await passwordInput.type(this.config.password, { delay: 50 });
        }

        // Click sign in button
        console.log("   Clicking sign in...");
        await this.page.waitForSelector('.submitButton-LQwxK8Bm', { timeout: 5000 });
        const signInButton = await this.page.$('.submitButton-LQwxK8Bm');
        if (signInButton) {
            await signInButton.click();
        }

        // Check for captcha and wait for user to solve it
        await this.delay(2000);
        const hasCaptcha = await this.page.$('.recaptchaContainer-LQwxK8Bm, #g-recaptcha-response, iframe[title="reCAPTCHA"]');
        if (hasCaptcha) {
            console.log("⚠️  CAPTCHA DETECTED! Please solve it manually...");
            console.log("   Waiting up to 60 seconds... (Press ENTER to skip wait)");

            // Race between: captcha solved, timeout, or user pressing Enter
            const loginPromise = this.page.waitForSelector('[data-name="header-user-menu-button"], .tv-header__user-menu-button', { timeout: 60000 });

            const enterPromise = new Promise<void>((resolve) => {
                const onData = () => {
                    process.stdin.removeListener('data', onData);
                    console.log("   ⏭️  Skipping wait...");
                    resolve();
                };
                process.stdin.once('data', onData);
                // Cleanup after timeout
                setTimeout(() => process.stdin.removeListener('data', onData), 60000);
            });

            try {
                await Promise.race([loginPromise, enterPromise]);

                // After captcha, check if sign-in button still needs to be clicked
                const signInBtn = await this.page.$('.submitButton-LQwxK8Bm');
                if (signInBtn) {
                    console.log("   Clicking Sign In button...");
                    await signInBtn.click();
                    await this.delay(3000);
                }

                console.log("✅ Continuing with login...");
                this.isLoggedIn = true;

                // Save session for future use (after CAPTCHA solved)
                await this.saveSession();
                return;
            } catch (e) {
                console.log("⚠️  Captcha timeout. Continuing anyway...");
            }
        }

        // Wait for login to complete (no captcha case)
        await this.delay(3000);

        // Verify login by checking for user menu or avatar
        try {
            await this.page.waitForSelector('[data-name="header-user-menu-button"], .tv-header__user-menu-button', { timeout: 15000 });
            console.log("✅ Login successful!");
            this.isLoggedIn = true;

            // Save session for future use
            await this.saveSession();
        } catch (e) {
            console.log("⚠️  Could not verify login. Continuing anyway...");
            this.isLoggedIn = true; // Assume success and continue
        }
    }

    /**
     * Navigate to the specified chart URL
     */
    private async navigateToChart(): Promise<void> {
        if (!this.page) throw new Error("Browser not initialized");

        console.log(`📊 Navigating to chart: ${this.config.chartUrl}`);

        await this.page.goto(this.config.chartUrl, {
            waitUntil: "networkidle2",
            timeout: 60000,
        });

        // Wait for chart to load
        await this.delay(3000);

        // Wait for chart container to be visible
        try {
            await this.page.waitForSelector('.chart-container, .chart-markup-table, [data-name="chart-container"]', { timeout: 30000 });
            console.log("✅ Chart loaded!");
        } catch (e) {
            console.log("⚠️  Could not verify chart load. Continuing...");
        }

        // Dismiss any promotion modals that might appear on page load
        await this.dismissPromotionModal();
    }

    /**
     * Connect to trading broker (Paper Trading or Coinbase Advanced based on IS_PROD)
     */
    private async connectPaperTradingBroker(): Promise<void> {
        if (!this.page) throw new Error("Browser not initialized");

        const brokerType = IS_PROD ? "COINBASE" : "Paper";
        const brokerName = IS_PROD ? "Coinbase Advanced" : "Paper Trading";
        console.log(`🔗 Connecting to ${brokerName} broker...`);

        try {
            // Wait for and click the broker card
            await this.page.waitForSelector(`[data-broker="${brokerType}"]`, { timeout: 10000 });
            await this.page.click(`[data-broker="${brokerType}"]`);
            await this.delay(1000);

            // Click the Connect button to confirm broker connection
            await this.page.waitForSelector('button[name="broker-login-submit-button"]', { timeout: 3000 });
            await this.page.click('button[name="broker-login-submit-button"]');
            await this.delay(2000);

            console.log(`✅ ${brokerName} broker connected!`);
            this.isBrokerConnected = true;
        } catch (e) {
            console.log(`⚠️  Could not connect ${brokerName} broker automatically. May need manual connection.`);
            // Still mark as connected to allow manual intervention
            this.isBrokerConnected = true;
        }
    }

    /**
     * Open the order form (internal helper)
     */
    private async openOrderForm(): Promise<void> {
        if (!this.page) throw new Error("Browser not initialized");

        console.log("📝 Opening order form...");

        // Check if order form is already visible
        const orderFormVisible = await this.page.$('[data-name="side-control-buy"], [data-name="side-control-sell"]');
        if (orderFormVisible) {
            console.log("   Order form already visible");
            return;
        }

        // Click the Trade button to open order form
        try {
            const tradeBtn = await this.page.$('[data-qa-id="trade-panel-button"], .tradeButton-YZUjA1Rh button');
            if (tradeBtn) {
                await tradeBtn.click();
                await this.delay(1000);
                console.log("   Clicked Trade button");
            }
        } catch (e) {
            console.log("   Trade button not found");
        }
    }

    /**
     * Prepare the order form (public method for startup initialization)
     * Ensures the order form is visible and ready for quick trading
     */
    async prepareOrderForm(): Promise<void> {
        await this.openOrderForm();
        // Give it a moment to fully render
        await this.delay(500);
        console.log("✅ Order form ready!");
    }

    /**
     * Validate that the CDP connection is still alive.
     * Returns 'valid' if connection is good, 'recovered' if we got a fresh page reference,
     * or 'restart_needed' if the browser needs to be restarted.
     */
    private async validateConnection(): Promise<'valid' | 'recovered' | 'restart_needed'> {
        if (!this.page || !this.browser) return 'restart_needed';

        try {
            // Simple evaluate to test if the frame is still attached
            await this.page.evaluate(() => true);
            return 'valid';
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            // Check for detached frame or protocol errors
            if (errorMsg.includes('detached Frame') ||
                errorMsg.includes('Protocol error') ||
                errorMsg.includes('Target closed') ||
                errorMsg.includes('Session closed')) {

                console.log("⚠️  CDP connection stale (detached frame). Attempting recovery...");

                try {
                    // Try to get a fresh page reference
                    const pages = await this.browser.pages();
                    if (pages.length > 0) {
                        // Find the TradingView page
                        for (const page of pages) {
                            try {
                                const url = page.url();
                                if (url.includes('tradingview.com')) {
                                    this.page = page;
                                    // Verify this page works
                                    await this.page.evaluate(() => true);
                                    console.log("✅ Recovered page reference from browser.");
                                    return 'recovered';
                                }
                            } catch {
                                // This page is also detached, continue
                            }
                        }
                    }
                } catch (recoveryError) {
                    // Browser connection completely lost
                }

                console.log("❌ Could not recover page reference. Full browser restart needed.");
                return 'restart_needed';
            }

            // Other errors, assume connection is okay but something else failed
            return 'valid';
        }
    }

    /**
     * Restart the browser completely - close existing browser and reinitialize.
     * Used when CDP connection is completely lost.
     */
    async restartBrowser(): Promise<void> {
        console.log("\n🔄 Restarting browser...");

        // Try to close existing browser gracefully
        try {
            if (this.browser) {
                await this.browser.close();
            }
        } catch (e) {
            // Browser may already be disconnected, that's fine
            console.log("   (Browser was already disconnected)");
        }

        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
        this.isBrokerConnected = false;

        // Reinitialize
        await this.initialize();
        await this.prepareOrderForm();

        console.log("✅ Browser restarted and ready!\n");
    }

    /**
     * Ensure session is connected, handling multiple potential disconnect modals
     * and broker disconnection scenarios
     */
    private async ensureConnection(): Promise<void> {
        if (!this.page) return;

        // First, validate that our CDP connection is still alive
        const connectionStatus = await this.validateConnection();
        if (connectionStatus === 'restart_needed') {
            // Restart browser and return - caller should retry
            await this.restartBrowser();
            return;
        }

        // Try up to 3 times to clear disconnect modals (handles sequential modals)
        for (let i = 0; i < 3; i++) {
            const disconnectType = await this.page.evaluate(() => {
                const bodyText = document.body.innerText;
                // Type A: Account accessed elsewhere
                if (bodyText.includes('Your session ended because your account was accessed from another browser')) {
                    return 'ACCOUNT_ACCESSED';
                }
                // Type B: Generic connection closed (e.g. timeout/paywall)
                const closedTitle = document.querySelector('.title-qAW2FX1Z');
                if (closedTitle && closedTitle.textContent?.includes("We've closed this connection")) {
                    return 'CONNECTION_CLOSED';
                }
                return null;
            });

            if (!disconnectType) {
                if (i > 0) console.log("✅ Connection verified/restored.");
                break; // Exit modal loop, but continue to broker check
            }

            console.log(`⚠️  Disconnect detected(${disconnectType}).Attempt ${i + 1}/3 to reconnect...`);

            // Try all known reconnect buttons
            // 1. Session ended buttons (.wrapperButton..., .button-Z0...)
            // 2. Connection closed button (data-qa-id="close_paywall_button")
            const connectBtn = await this.page.$('.wrapperButton-yXyW_CNE button, button.button-Z0XMhbiI, button[data-qa-id="close_paywall_button"]');

            if (connectBtn) {
                console.log("   Clicking reconnect/refresh button...");
                await connectBtn.click();
                // Wait for modal to disappear or next one to appear. 
                // The user noted "sometimes after you click restore connection.. it shows the 'session disconnected' modal"
                await this.delay(2500);
            } else {
                console.log("   No connect button found yet, waiting...");
                await this.delay(1000);
            }
        }

        // After clearing modals, check if we need to reconnect to the broker
        // This happens when we're logged in but disconnected from the broker session
        const brokerType = IS_PROD ? "COINBASE" : "Paper";
        const brokerName = IS_PROD ? "Coinbase Advanced" : "Paper Trading";
        const brokerCard = await this.page.$(`[data-broker="${brokerType}"]`);
        if (brokerCard) {
            console.log(`⚠️  ${brokerName} broker disconnected. Reconnecting...`);
            try {
                await brokerCard.click();
                await this.delay(1000);

                // Click the Connect button to confirm broker connection
                const loginBtn = await this.page.$('button[name="broker-login-submit-button"]');
                if (loginBtn) {
                    console.log("   Clicking broker connect button...");
                    await loginBtn.click();
                    await this.delay(2000);
                }
                console.log(`✅ ${brokerName} broker reconnected!`);
            } catch (e) {
                console.log(`⚠️  Could not reconnect ${brokerName} broker automatically.`);
            }
        }
    }

    /**
     * Place a market order with optional TP/SL
     * Will automatically restart browser and retry once if CDP connection is lost.
     */
    async placeMarketOrder(params: OrderParams, isRetry: boolean = false): Promise<ExecutionResult> {
        // Create section logger for color-coded output
        const logger = createSectionLogger();

        // Helper to get logs array for return value
        const getLogs = () => logger.getLogs();

        // Backwards-compatible log function that uses the logger
        const log = (msg: string) => logger.log(msg);

        if (!this.page) {
            if (isRetry) {
                return { success: false, error: "Browser not initialized after restart", executionLogs: getLogs() };
            }
            logger.warn("Browser not initialized. Attempting to restart...");
            await this.restartBrowser();
            return this.placeMarketOrder(params, true);
        }

        // Print main order header
        logger.header(`PLACING MARKET ORDER${isRetry ? ' (RETRY)' : ''}`, 'start');
        logger.log(`Direction: ${params.direction}`);
        logger.log(`Quantity: ${params.quantity}`);
        if (params.stopLoss) logger.log(`Stop Loss: $${params.stopLoss}`);
        if (params.takeProfit) logger.log(`Take Profit: $${params.takeProfit}`);
        logger.log(`Page URL: ${this.page.url()}`);

        try {
            // Ensure we are connected before trying to interact
            logger.startSection('connection');
            logger.log("Checking connection status...");
            await this.ensureConnection();
            logger.success("Connection verified");

            // Dismiss any promotion modals that might block order placement
            logger.log("Checking for promotion modals...");
            await this.dismissPromotionModal();

            // === CHECK FOR EXISTING OPEN POSITIONS ===
            logger.startSection('position_check');
            logger.log("Checking for existing open positions...");

            // Click on positions tab to check
            const posTab = await this.page.$('button#positions');
            if (posTab) {
                await posTab.click();
                await this.delay(1000);
            }

            // Check if there are any open positions by looking for rows with data-row-id
            // Based on actual HTML: <tr class="ka-tr ka-row" data-row-id="BYBIT:ETHUSDT.P">
            const existingPosition = await this.page.evaluate(() => {
                // Scope search to the positions tab container to avoid selecting hidden rows from other tabs
                const positionsContainer = document.querySelector('div[data-account-manager-page-id="positions"]');
                const root = positionsContainer || document;

                // Most reliable: check for position rows with data-row-id attribute
                const positionRows = root.querySelectorAll('tr.ka-tr.ka-row[data-row-id]');
                if (positionRows.length === 0) {
                    return null;
                }

                // Get details from the first position row
                const firstRow = positionRows[0];
                const rowId = firstRow.getAttribute('data-row-id') || 'unknown';

                // Use exact data-label attributes from the HTML
                const symbolCell = firstRow.querySelector('td[data-label="Symbol"]');
                const sideCell = firstRow.querySelector('td[data-label="Side"]');
                const qtyCell = firstRow.querySelector('td[data-label="Qty"]');
                const avgPriceCell = firstRow.querySelector('td[data-label="Avg Fill Price"]');
                const pnlCell = firstRow.querySelector('td[data-label="Unrealized P&L"]');

                return {
                    count: positionRows.length,
                    rowId,
                    symbol: symbolCell?.textContent?.trim() || 'unknown',
                    side: sideCell?.textContent?.trim() || 'unknown',
                    qty: qtyCell?.textContent?.trim() || 'unknown',
                    avgPrice: avgPriceCell?.textContent?.trim() || 'unknown',
                    pnl: pnlCell?.textContent?.trim() || 'unknown'
                };
            });

            if (existingPosition && existingPosition.count > 0) {
                log(`   ⚠️ EXISTING POSITION DETECTED!`);
                log(`   [POSITION] Row ID: ${existingPosition.rowId}`);
                log(`   [POSITION] Symbol: ${existingPosition.symbol}`);
                log(`   [POSITION] Side: ${existingPosition.side}`);
                log(`   [POSITION] Qty: ${existingPosition.qty}`);
                log(`   [POSITION] Avg Price: ${existingPosition.avgPrice}`);
                log(`   [POSITION] Unrealized P&L: ${existingPosition.pnl}`);
                log(`   ❌ ORDER BLOCKED: Cannot place new order while position is open`);
                log(`${"═".repeat(60)}\n`);

                return {
                    success: false,
                    error: `Existing position detected: ${existingPosition.side} ${existingPosition.qty} @ ${existingPosition.avgPrice} (P&L: ${existingPosition.pnl}). Close the existing position before placing a new order.`,
                    executionLogs: getLogs()
                };
            } else {
                log(`   ✓ No existing positions detected, proceeding with order`);
            }

            // Ensure order form is open
            logger.startSection('order_form');
            logger.log("Opening order form...");
            const orderFormBefore = await this.page.$('[data-name="side-control-buy"], [data-name="side-control-sell"]');
            logger.detail(`Order form visible before: ${orderFormBefore ? 'YES' : 'NO'}`);
            await this.openOrderForm();
            const orderFormAfter = await this.page.$('[data-name="side-control-buy"], [data-name="side-control-sell"]');
            logger.detail(`Order form visible after: ${orderFormAfter ? 'YES' : 'NO'}`);

            // Handle auto-margin sizing if quantity is -1
            let useMarginMode = params.quantity < 0;
            let marginAmount = 0;
            let feeAmount = 0; // Captured from order preview in prod mode
            let autoCalculatedContracts = 0; // For prod mode contract calculation

            if (useMarginMode) {
                const fieldName = IS_PROD ? "Balance" : "Equity";
                log(`   📊 Auto-sizing position from ${fieldName}...`);

                // Read balance/equity from the account summary
                // Find the specific field by matching the title text
                const balanceRaw = await this.page.evaluate((targetField: string) => {
                    const fields = Array.from(document.querySelectorAll('.accountSummaryField-tWnxJF90'));
                    for (const field of fields) {
                        const title = field.querySelector('.title-tWnxJF90');
                        if (title?.textContent?.trim() === targetField) {
                            const value = field.querySelector('.value-tWnxJF90');
                            return {
                                text: value?.textContent || '0',
                                exists: true,
                                fieldName: targetField
                            };
                        }
                    }
                    // Fallback: try first field if target not found
                    const firstValue = document.querySelector('.accountSummaryField-tWnxJF90 .value-tWnxJF90');
                    return {
                        text: firstValue?.textContent || '0',
                        exists: !!firstValue,
                        fieldName: 'fallback'
                    };
                }, fieldName);
                log(`   [DOM] ${fieldName} field found: ${balanceRaw.exists} (matched: ${balanceRaw.fieldName})`);
                log(`   [DOM] ${fieldName} raw text: "${balanceRaw.text}"`);

                const balance = parseFloat(balanceRaw.text.replace(/,/g, '').replace(/[^\d.-]/g, ''));
                log(`   ${fieldName} parsed: $${balance.toLocaleString()}`);

                if (IS_PROD) {
                    // PROD MODE: Calculate max contracts based on price, contract size, and leverage
                    // Read current price from the side button (buy or sell based on direction)
                    const sideButtonSelector = params.direction === "LONG"
                        ? '[data-name="side-control-buy"]'
                        : '[data-name="side-control-sell"]';

                    const priceRaw = await this.page.evaluate((selector: string) => {
                        const btn = document.querySelector(selector);
                        const valueEl = btn?.querySelector('.value-OnZ1FRe5');
                        return {
                            text: valueEl?.textContent || '0',
                            exists: !!valueEl
                        };
                    }, sideButtonSelector);

                    log(`   [PROD] Price from side button: "${priceRaw.text}"`);
                    const currentPrice = parseFloat(priceRaw.text.replace(/,/g, '')) || 0;

                    if (currentPrice > 0) {
                        // Calculate margin per contract: (price * contractSize) / leverage
                        const marginPerContract = (currentPrice * COINBASE_CONTRACT_SIZE) / COINBASE_LEVERAGE;
                        log(`   [PROD] Margin per contract: $${marginPerContract.toFixed(4)} = ($${currentPrice} × ${COINBASE_CONTRACT_SIZE}) / ${COINBASE_LEVERAGE}`);

                        // Calculate max contracts that fit in 90% of balance (must be whole number)
                        const availableMargin = balance * 0.90;
                        autoCalculatedContracts = Math.floor(availableMargin / marginPerContract);
                        marginAmount = autoCalculatedContracts * marginPerContract;

                        log(`   [PROD] Available margin (90%): $${availableMargin.toFixed(2)}`);
                        log(`   [PROD] Max whole contracts: ${autoCalculatedContracts}`);
                        log(`   [PROD] Actual margin used: $${marginAmount.toFixed(2)}`);
                    } else {
                        log(`   [PROD] ⚠️ Could not read price, defaulting to 1 contract`);
                        autoCalculatedContracts = 1;
                    }
                } else {
                    // PAPER TRADING MODE: Use 90% of equity as margin (existing behavior)
                    const MAX_MARGIN = IS_ALT ? Infinity : 1000;
                    marginAmount = Math.floor(balance * 0.90 * 100) / 100; // 90% of balance, rounded to 2 decimals

                    // Cap margin at maximum allowed
                    if (marginAmount > MAX_MARGIN) {
                        log(`   ⚠️ Margin $${marginAmount.toLocaleString()} exceeds max $${MAX_MARGIN}, capping...`);
                        marginAmount = MAX_MARGIN;
                    }

                    log(`   Using margin: $${marginAmount.toLocaleString()} (max: $${MAX_MARGIN})`);
                }
            }

            // 1. Click the direction button FIRST (Buy or Sell)
            logger.startSection('direction', params.direction);
            const sideSelector = params.direction === "LONG"
                ? '[data-name="side-control-buy"]'
                : '[data-name="side-control-sell"]';

            logger.log(`Clicking ${params.direction === "LONG" ? "BUY" : "SELL"} side...`);
            logger.dom(`Selector: ${sideSelector}`);
            const sideBtn = await this.page.waitForSelector(sideSelector, { timeout: 5000 });
            const sideBtnState = await this.page.evaluate((sel) => {
                const el = document.querySelector(sel) as HTMLElement;
                return {
                    exists: !!el,
                    classList: el?.className || 'N/A',
                    ariaChecked: el?.getAttribute('aria-checked') || 'N/A'
                };
            }, sideSelector);
            log(`   [DOM] Button class: ${sideBtnState.classList.substring(0, 50)}...`);
            log(`   [DOM] aria-checked before click: ${sideBtnState.ariaChecked}`);
            await this.page.click(sideSelector);
            await this.delay(500);
            logger.success("Side button clicked");

            // 2. Select Market order type (switch from Limit)
            logger.startSection('order_type');
            logger.log("Selecting Market order type...");
            logger.dom("Selector: button#Market");
            await this.page.waitForSelector('button#Market', { timeout: 5000 });
            const marketBtnState = await this.page.evaluate(() => {
                const el = document.querySelector('button#Market') as HTMLElement;
                return {
                    exists: !!el,
                    ariaSelected: el?.getAttribute('aria-selected') || 'N/A',
                    innerText: el?.innerText || 'N/A'
                };
            });
            log(`   [DOM] Market button text: "${marketBtnState.innerText}"`);
            log(`   [DOM] aria-selected before: ${marketBtnState.ariaSelected}`);
            await this.page.click('button#Market');
            await this.delay(500);
            logger.success("Market order type selected");

            // 2.5. Set quantity or margin based on mode
            let actualQuantity = params.quantity;

            if (useMarginMode && IS_PROD && autoCalculatedContracts > 0) {
                // PROD MODE AUTO-SIZING: Enter quantity directly (whole number of contracts)
                logger.startSection('quantity', `${autoCalculatedContracts} contracts`);
                logger.log(`Setting quantity to ${autoCalculatedContracts} contracts...`);
                logger.dom("Selector: #quantity-field");
                const qtyInput = await this.page.$('#quantity-field');
                if (qtyInput) {
                    log(`   [DOM] Quantity input found, clicking to select...`);
                    await qtyInput.click({ clickCount: 3 });
                    await this.delay(100);
                    log(`   [DOM] Typing quantity value: ${autoCalculatedContracts}`);
                    await qtyInput.type(String(autoCalculatedContracts), { delay: 100 });
                    // Read back to confirm
                    const qtyReadBack = await this.page.evaluate(() => {
                        const input = document.querySelector('#quantity-field') as HTMLInputElement;
                        return input?.value || 'N/A';
                    });
                    log(`   [DOM] Quantity read-back value: "${qtyReadBack}"`);
                    actualQuantity = parseFloat(qtyReadBack.replace(/,/g, '')) || autoCalculatedContracts;
                } else {
                    log(`   ⚠️ [DOM] Quantity input NOT found!`);
                    actualQuantity = autoCalculatedContracts;
                }
                await this.delay(500);
                log(`   [PROD] Quantity set to ${actualQuantity} contracts ✓`);
            } else if (useMarginMode && marginAmount > 0) {
                // PAPER TRADING AUTO-SIZING: Enter margin via margin input
                log(`   Setting margin to $${marginAmount.toFixed(2)}...`);
                log(`   [DOM] Selector: #quantity-calculation-field`);
                const marginInput = await this.page.$('#quantity-calculation-field');
                if (marginInput) {
                    log(`   [DOM] Margin input found, clicking to select...`);
                    await marginInput.click({ clickCount: 3 });
                    await this.delay(100);
                    log(`   [DOM] Typing margin value: ${marginAmount.toFixed(2)}`);
                    await marginInput.type(marginAmount.toFixed(2), { delay: 100 });
                } else {
                    log(`   ⚠️ [DOM] Margin input NOT found!`);
                }
                await this.delay(500);

                // Read the actual quantity that was auto-calculated
                const qtyRaw = await this.page.evaluate(() => {
                    const qtyInput = document.querySelector('#quantity-field') as HTMLInputElement;
                    return {
                        value: qtyInput?.value || '0',
                        exists: !!qtyInput
                    };
                });
                log(`   [DOM] Quantity field found: ${qtyRaw.exists}`);
                log(`   [DOM] Quantity field value: "${qtyRaw.value}"`);
                actualQuantity = parseFloat(qtyRaw.value.replace(/,/g, ''));
                log(`   Auto-calculated quantity: ${actualQuantity} contracts`);
            } else if (params.quantity > 0) {
                // Manual quantity mode: enter quantity directly
                log(`   Setting quantity to ${params.quantity} contracts...`);
                log(`   [DOM] Selector: #quantity-field`);
                const qtyInput = await this.page.$('#quantity-field');
                if (qtyInput) {
                    log(`   [DOM] Quantity input found, clicking to select...`);
                    await qtyInput.click({ clickCount: 3 });
                    await this.delay(100);
                    log(`   [DOM] Typing quantity value: ${params.quantity}`);
                    await qtyInput.type(String(params.quantity), { delay: 100 });
                    // Read back to confirm
                    const qtyReadBack = await this.page.evaluate(() => {
                        const input = document.querySelector('#quantity-field') as HTMLInputElement;
                        return input?.value || 'N/A';
                    });
                    log(`   [DOM] Quantity read-back value: "${qtyReadBack}"`);
                    actualQuantity = parseFloat(qtyReadBack.replace(/,/g, '')) || params.quantity;
                } else {
                    log(`   ⚠️ [DOM] Quantity input NOT found!`);
                }
                await this.delay(500);
                log(`   Quantity set to ${actualQuantity} contracts ✓`);
            }

            // 3. Set Take Profit if provided
            if (params.takeProfit) {
                logger.startSection('take_profit', `$${params.takeProfit.toFixed(2)}`);
                logger.log("Enabling take profit...");
                logger.dom('Selector: input[data-qa-id="order-ticket-profit-checkbox-bracket"]');
                const tpCheckbox = await this.page.$('input[data-qa-id="order-ticket-profit-checkbox-bracket"]');
                if (tpCheckbox) {
                    const tpCheckedBefore = await this.page.evaluate(() => {
                        const cb = document.querySelector('input[data-qa-id="order-ticket-profit-checkbox-bracket"]') as HTMLInputElement;
                        return cb?.checked;
                    });
                    log(`   [DOM] TP checkbox checked before: ${tpCheckedBefore}`);
                    await tpCheckbox.click();
                    await this.delay(300);
                    log(`   TP checkbox clicked ✓`);
                } else {
                    log(`   ⚠️ [DOM] TP checkbox NOT found!`);
                }

                log(`   Setting take profit to ${params.takeProfit.toFixed(2)}...`);
                log(`   [DOM] Selector: #take-profit-price-field`);
                const tpInput = await this.page.$('#take-profit-price-field');
                if (tpInput) {
                    log(`   [DOM] TP input found, clicking to select...`);
                    await tpInput.click({ clickCount: 3 });
                    await this.delay(100);
                    log(`   [DOM] Typing TP value: ${params.takeProfit.toFixed(2)}`);
                    await tpInput.type(params.takeProfit.toFixed(2), { delay: 150 });
                    // Read back
                    const tpReadBack = await this.page.evaluate(() => {
                        const input = document.querySelector('#take-profit-price-field') as HTMLInputElement;
                        return input?.value || 'N/A';
                    });
                    log(`   [DOM] TP read-back value: "${tpReadBack}"`);
                } else {
                    log(`   ⚠️ [DOM] TP input NOT found!`);
                }
                await this.delay(300);
                logger.success("Take profit set");
            }

            // 4. Set Stop Loss if provided
            if (params.stopLoss) {
                // In prod mode, clicking TP checkbox auto-enables SL, so skip the SL checkbox click
                logger.startSection('stop_loss', `$${params.stopLoss.toFixed(2)}`);
                if (!IS_PROD) {
                    logger.log("Enabling stop loss...");
                    logger.dom('Selector: input[data-qa-id="order-ticket-loss-checkbox-bracket"]');
                    const slCheckbox = await this.page.$('input[data-qa-id="order-ticket-loss-checkbox-bracket"]');
                    if (slCheckbox) {
                        const slCheckedBefore = await this.page.evaluate(() => {
                            const cb = document.querySelector('input[data-qa-id="order-ticket-loss-checkbox-bracket"]') as HTMLInputElement;
                            return cb?.checked;
                        });
                        log(`   [DOM] SL checkbox checked before: ${slCheckedBefore}`);
                        await slCheckbox.click();
                        await this.delay(300);
                        log(`   SL checkbox clicked ✓`);
                    } else {
                        log(`   ⚠️ [DOM] SL checkbox NOT found!`);
                    }
                } else {
                    log("   [PROD] SL auto-enabled by TP checkbox, skipping SL checkbox click");
                }

                log(`   Setting stop loss to ${params.stopLoss.toFixed(2)}...`);
                log(`   [DOM] Selector: #stop-loss-price-field`);
                const slInput = await this.page.$('#stop-loss-price-field');
                if (slInput) {
                    log(`   [DOM] SL input found, clicking to select...`);
                    await slInput.click({ clickCount: 3 });
                    await this.delay(100);
                    log(`   [DOM] Typing SL value: ${params.stopLoss.toFixed(2)}`);
                    await slInput.type(params.stopLoss.toFixed(2), { delay: 300 });
                    // Read back
                    const slReadBack = await this.page.evaluate(() => {
                        const input = document.querySelector('#stop-loss-price-field') as HTMLInputElement;
                        return input?.value || 'N/A';
                    });
                    log(`   [DOM] SL read-back value: "${slReadBack}"`);
                } else {
                    log(`   ⚠️ [DOM] SL input NOT found!`);
                }
                await this.delay(300);
                logger.success("Stop loss set");
            }

            // 5. Click the Place Order button
            logger.startSection('place_order');
            logger.log("Clicking Place Order button...");
            log(`   [DOM] Selector: button[data-name="place-and-modify-button"]`);
            const placeBtn = await this.page.waitForSelector('button[data-name="place-and-modify-button"]', { timeout: 5000 });
            const placeBtnState = await this.page.evaluate(() => {
                const btn = document.querySelector('button[data-name="place-and-modify-button"]') as HTMLButtonElement;
                return {
                    exists: !!btn,
                    disabled: btn?.disabled,
                    innerText: btn?.innerText || 'N/A',
                    className: btn?.className || 'N/A'
                };
            });
            log(`   [DOM] Place button text: "${placeBtnState.innerText}"`);
            log(`   [DOM] Place button disabled: ${placeBtnState.disabled}`);
            log(`   [DOM] Place button class: "${placeBtnState.className}"`);

            // Wait 1 second for form to fully settle before placing order
            log("   Waiting 1s for form to settle...");
            await this.delay(1000);

            // === DEBUG SETUP: Create debug directory and file ===
            const debugTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const tpPrice = params.takeProfit ? `TP${params.takeProfit}` : 'noTP';
            const debugDir = path.join(__dirname, '..', 'debug_logs');
            const debugFileName = `order_debug_${debugTimestamp}_${tpPrice}.txt`;
            const debugFilePath = path.join(debugDir, debugFileName);

            // Ensure debug directory exists
            if (!fs.existsSync(debugDir)) {
                fs.mkdirSync(debugDir, { recursive: true });
            }

            const debugLines: string[] = [];
            const debugLog = (msg: string) => {
                const line = `[${new Date().toISOString()}] ${msg}`;
                debugLines.push(line);
                log(msg); // Also add to regular logs
            };

            debugLog(`=== ORDER DEBUG START ===`);
            debugLog(`Direction: ${params.direction}`);
            debugLog(`Take Profit: ${params.takeProfit}`);
            debugLog(`Stop Loss: ${params.stopLoss}`);

            // === SCREENSHOT #1: Order form BEFORE clicking ===
            const screenshotDir = path.join(debugDir, 'screenshots');
            if (!fs.existsSync(screenshotDir)) {
                fs.mkdirSync(screenshotDir, { recursive: true });
            }
            const screenshotBefore = path.join(screenshotDir, `${debugTimestamp}_${tpPrice}_01_before_click.png`);
            try {
                await this.page.screenshot({ path: screenshotBefore, fullPage: false });
                debugLog(`[SCREENSHOT] Before click saved: ${screenshotBefore}`);
            } catch (e) {
                debugLog(`[SCREENSHOT] Failed to save before screenshot: ${e}`);
            }

            // === DUMP ORDER FORM STATE ===
            const orderFormState = await this.page.evaluate(() => {
                const marginInput = document.querySelector('#quantity-calculation-field') as HTMLInputElement;
                const qtyInput = document.querySelector('input[data-qa-id="order-ticket-qty-input"]') as HTMLInputElement;
                const tpInput = document.querySelector('#take-profit-price-field') as HTMLInputElement;
                const slInput = document.querySelector('#stop-loss-price-field') as HTMLInputElement;

                return {
                    margin: marginInput?.value || 'N/A',
                    qty: qtyInput?.value || 'N/A',
                    tp: tpInput?.value || 'N/A',
                    sl: slInput?.value || 'N/A'
                };
            });
            debugLog(`[ORDER FORM] Margin: ${orderFormState.margin}`);
            debugLog(`[ORDER FORM] Qty: ${orderFormState.qty}`);
            debugLog(`[ORDER FORM] TP: ${orderFormState.tp}`);
            debugLog(`[ORDER FORM] SL: ${orderFormState.sl}`);

            // === CLICK THE BUTTON ===
            await this.page.click('button[data-name="place-and-modify-button"]');
            log(`   Place Order button clicked ✓`);
            debugLog(`[CLICK] Place Order button clicked at ${new Date().toISOString()}`);

            // === PROD MODE: Order Preview Flow ===
            // In prod (Coinbase), clicking place order shows a preview with fee
            // We need to read the fee and then click "Send Order" to confirm
            if (IS_PROD) {
                log(`   [PROD] Waiting for order preview...`);
                await this.delay(500);

                // Read fee from order preview
                const feeResult = await this.page.evaluate(() => {
                    const listItems = Array.from(document.querySelectorAll('[class*="listItem-"]'));
                    for (const item of listItems) {
                        const title = item.querySelector('[class*="listItemTitle-"]');
                        if (title?.textContent?.trim() === 'Fee') {
                            const data = item.querySelector('[class*="listItemData-"]');
                            return {
                                found: true,
                                text: data?.textContent?.trim() || '0',
                            };
                        }
                    }
                    return { found: false, text: '0' };
                });

                if (feeResult.found) {
                    feeAmount = parseFloat(feeResult.text.replace(/[^0-9.-]/g, '')) || 0;
                    log(`   [PROD] Fee from preview: $${feeAmount}`);
                } else {
                    log(`   [PROD] ⚠️ Could not find Fee in order preview`);
                }

                // Click "Send Order" button to confirm
                log(`   [PROD] Clicking Send Order to confirm...`);

                // Use text-based search as primary method (most reliable)
                const clicked = await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    for (const btn of buttons) {
                        if (btn.textContent?.trim() === 'Send Order') {
                            (btn as HTMLButtonElement).click();
                            return { clicked: true, text: btn.textContent };
                        }
                    }
                    // Also try buttons that contain "Send Order"
                    for (const btn of buttons) {
                        if (btn.textContent?.includes('Send Order')) {
                            (btn as HTMLButtonElement).click();
                            return { clicked: true, text: btn.textContent };
                        }
                    }
                    return { clicked: false, text: null };
                });

                if (clicked.clicked) {
                    log(`   [PROD] Send Order clicked ✓ (button text: "${clicked.text?.trim()}")`);
                } else {
                    log(`   [PROD] ⚠️ Could not find Send Order button`);
                }
                await this.delay(1000); // Wait for order to process
            }

            // === CHECK BUTTON STATE IMMEDIATELY AFTER CLICK (500ms) ===
            await this.delay(500);
            const placeBtnStateAfter = await this.page.evaluate(() => {
                const btn = document.querySelector('button[data-name="place-and-modify-button"]') as HTMLButtonElement;
                return {
                    exists: !!btn,
                    disabled: btn?.disabled,
                    innerText: btn?.innerText || 'N/A',
                    className: btn?.className || 'N/A'
                };
            });
            debugLog(`[BUTTON AFTER 500ms] Text: "${placeBtnStateAfter.innerText}"`);
            debugLog(`[BUTTON AFTER 500ms] Disabled: ${placeBtnStateAfter.disabled}`);
            debugLog(`[BUTTON AFTER 500ms] Class: "${placeBtnStateAfter.className}"`);

            // === SCREENSHOT #2: 1 second after click ===
            await this.delay(500); // Now at 1 second
            const screenshot1s = path.join(screenshotDir, `${debugTimestamp}_${tpPrice}_02_after_1s.png`);
            try {
                await this.page.screenshot({ path: screenshot1s, fullPage: false });
                debugLog(`[SCREENSHOT] After 1s saved: ${screenshot1s}`);
            } catch (e) {
                debugLog(`[SCREENSHOT] Failed to save 1s screenshot: ${e}`);
            }

            // === DUMP ALL TOASTS (not just rejections) ===
            const allToasts = await this.page.evaluate(() => {
                const toastList = document.querySelector('.toastListInner-Hvz5Irky');
                if (!toastList) return { found: false, html: '', count: 0 };

                const toasts = toastList.querySelectorAll('.toastGroup-JUpQSPBo, .contentContainerWrapper-zMOxH_8U');
                const toastTexts: string[] = [];
                toasts.forEach((toast, i) => {
                    toastTexts.push(`Toast ${i}: ${toast.textContent?.substring(0, 200) || 'empty'}`);
                });

                return {
                    found: true,
                    html: toastList.innerHTML.substring(0, 2000),
                    count: toasts.length,
                    texts: toastTexts
                };
            });
            debugLog(`[TOASTS] Found: ${allToasts.found}, Count: ${allToasts.count}`);
            if (allToasts.found && (allToasts as { texts?: string[] }).texts) {
                for (const t of (allToasts as { texts: string[] }).texts) {
                    debugLog(`[TOASTS] ${t}`);
                }
            }

            // Wait for order to fill while watching for rejection toasts
            // Poll every 2 seconds for position state, total 10 seconds
            log("   Waiting for order to fill (10 seconds, watching for rejections)...");
            const waitStartTime = Date.now();
            const totalWaitMs = 10000;
            const pollIntervalMs = 2000;
            let rejectionDetected = false;
            let rejectionMessage = "";
            let pollCount = 0;

            while (Date.now() - waitStartTime < totalWaitMs) {
                pollCount++;
                const elapsedMs = Date.now() - waitStartTime;

                // === CHECK POSITION TAB STATE ===
                const positionState = await this.page.evaluate(() => {
                    const positionsContainer = document.querySelector('div[data-account-manager-page-id="positions"]');
                    const root = positionsContainer || document;
                    const positionRows = root.querySelectorAll('tr.ka-tr.ka-row[data-row-id]');

                    if (positionRows.length === 0) {
                        return { hasPosition: false, count: 0, details: null };
                    }

                    const firstRow = positionRows[0];
                    const symbol = firstRow.querySelector('td[data-label="Symbol"]')?.textContent?.trim() || '';
                    const side = firstRow.querySelector('td[data-label="Side"]')?.textContent?.trim() || '';
                    const qty = firstRow.querySelector('td[data-label="Qty"]')?.textContent?.trim() || '';
                    const avgPrice = firstRow.querySelector('td[data-label="Avg Fill Price"]')?.textContent?.trim() || '';

                    return {
                        hasPosition: true,
                        count: positionRows.length,
                        details: { symbol, side, qty, avgPrice }
                    };
                });

                debugLog(`[POSITION @${(elapsedMs / 1000).toFixed(1)}s] Has position: ${positionState.hasPosition}, Count: ${positionState.count}`);
                if (positionState.details) {
                    debugLog(`[POSITION @${(elapsedMs / 1000).toFixed(1)}s] ${positionState.details.side} ${positionState.details.qty} @ ${positionState.details.avgPrice}`);
                }

                // Check for rejection toast
                const rejection = await this.page.evaluate(() => {
                    // Look for the rejection toast container
                    const toastContainer = document.querySelector('.contentContainerWrapper-zMOxH_8U');
                    if (!toastContainer) return null;

                    // Check if this is an order rejection
                    const header = toastContainer.querySelector('.header-zMOxH_8U');
                    const headerText = header?.textContent?.trim() || '';

                    if (headerText.includes('rejected') || headerText.includes('Rejected')) {
                        // Get the rejection reason
                        const content = toastContainer.querySelector('.content-MMDBBz2U');
                        const orderInfo = toastContainer.querySelector('.orderInfo-MMDBBz2U');
                        const symbol = toastContainer.querySelector('.tag-text-rVj4hiuX');

                        return {
                            isRejection: true,
                            header: headerText,
                            orderInfo: orderInfo?.textContent?.trim() || '',
                            reason: content?.textContent?.trim() || 'Unknown rejection reason',
                            symbol: symbol?.textContent?.trim() || ''
                        };
                    }
                    return null;
                });

                if (rejection) {
                    rejectionDetected = true;
                    rejectionMessage = `${rejection.header} - ${rejection.orderInfo}: ${rejection.reason}`;
                    log(`   ⚠️ ORDER REJECTION DETECTED!`);
                    log(`   [REJECTION] Header: ${rejection.header}`);
                    log(`   [REJECTION] Order: ${rejection.orderInfo}`);
                    log(`   [REJECTION] Reason: ${rejection.reason}`);
                    log(`   [REJECTION] Symbol: ${rejection.symbol}`);
                    debugLog(`[REJECTION] ${rejectionMessage}`);
                    break;
                }

                await this.delay(pollIntervalMs);
            }

            // === SCREENSHOT #3: After wait complete ===
            const screenshotAfter = path.join(screenshotDir, `${debugTimestamp}_${tpPrice}_03_after_wait.png`);
            try {
                await this.page.screenshot({ path: screenshotAfter, fullPage: false });
                debugLog(`[SCREENSHOT] After wait saved: ${screenshotAfter}`);
            } catch (e) {
                debugLog(`[SCREENSHOT] Failed to save after screenshot: ${e}`);
            }

            // === DUMP FINAL TOAST STATE ===
            const finalToasts = await this.page.evaluate(() => {
                const toastList = document.querySelector('.toastListInner-Hvz5Irky');
                return toastList?.innerHTML?.substring(0, 3000) || 'No toast list found';
            });
            debugLog(`[FINAL TOASTS HTML] ${finalToasts}`);

            // === SAVE DEBUG FILE ===
            debugLog(`=== ORDER DEBUG END ===`);
            try {
                fs.writeFileSync(debugFilePath, debugLines.join('\n'));
                log(`   [DEBUG] Debug log saved to: ${debugFilePath}`);
            } catch (e) {
                log(`   [DEBUG] Failed to save debug file: ${e}`);
            }

            // If rejection was detected, return failure immediately
            if (rejectionDetected) {
                log(`   ❌ Order was rejected by the exchange`);
                log(`${"═".repeat(60)}\n`);
                return {
                    success: false,
                    error: `Order rejected: ${rejectionMessage}`,
                    executionLogs: getLogs()
                };
            }

            log("   Wait complete, reading results...");

            // === COMPREHENSIVE POSITION TABLE DEBUGGING ===
            log("   ═══ POSITION TABLE DIAGNOSTICS ═══");

            // First, check what tab we're on
            const currentTab = await this.page.evaluate(() => {
                const tabs = document.querySelectorAll('button[role="tab"]');
                const activeTab = Array.from(tabs).find(t => t.getAttribute('aria-selected') === 'true');
                return activeTab?.id || activeTab?.textContent || 'unknown';
            });
            log(`   [DOM] Current active tab: "${currentTab}"`);

            // Click positions tab explicitly to make sure we're on it
            log(`   [DOM] Clicking positions tab to ensure we're on it...`);
            const posTabClick = await this.page.$('button#positions');
            if (posTabClick) {
                await posTabClick.click();
                await this.delay(1000);
                log(`   [DOM] Positions tab clicked, waited 1s`);
            }

            // Dump ALL table cells and their data-labels
            const tableDump = await this.page.evaluate(() => {
                const cells = document.querySelectorAll('td[data-label]');
                const dump: Array<{ label: string, text: string, html: string }> = [];
                cells.forEach(cell => {
                    dump.push({
                        label: cell.getAttribute('data-label') || 'no-label',
                        text: cell.textContent?.trim() || '',
                        html: cell.innerHTML.substring(0, 200)
                    });
                });
                return dump;
            });
            log(`   [DOM] Found ${tableDump.length} table cells with data-label`);
            for (const cell of tableDump) {
                log(`   [DOM] Cell label="${cell.label}" text="${cell.text}"`);
            }

            // Try multiple selectors for avg fill price
            // Note: Coinbase uses "Avg Price" while Bybit Paper uses "Avg Fill Price"
            const avgFillSelectors = [
                'td[data-label="Avg Price"] span',       // Coinbase prod
                'td[data-label="Avg Price"]',            // Coinbase prod (no span)
                'td[data-label="Avg Fill Price"] span',  // Bybit paper
                'td[data-label="Avg Fill Price"]',
                'td[data-label="Avg. Fill Price"] span',
                'td[data-label="Entry Price"] span',
                'td[data-label="Price"] span',
                '.positions-table span[class*="price"]',
            ];

            log(`   [DOM] Trying multiple selectors for avg fill price:`);
            let foundAvgFill: string | null = null;
            for (const sel of avgFillSelectors) {
                const result = await this.page.evaluate((selector) => {
                    const el = document.querySelector(selector);
                    return {
                        exists: !!el,
                        text: el?.textContent?.trim() || null,
                        html: el?.outerHTML?.substring(0, 150) || null
                    };
                }, sel);
                log(`   [DOM] Selector "${sel}": exists=${result.exists}, text="${result.text}"`);
                if (result.exists && result.text && !foundAvgFill) {
                    foundAvgFill = result.text;
                }
            }

            // Also try to get the first position row's data
            const positionRowData = await this.page.evaluate(() => {
                // Try to find position rows
                const rows = document.querySelectorAll('tr.ka-tr, tr[class*="position"]');
                if (rows.length === 0) {
                    return { rowCount: 0, data: {} };
                }

                const firstRow = rows[0];
                const cells = firstRow.querySelectorAll('td');
                const data: Record<string, string> = {};
                cells.forEach(cell => {
                    const label = cell.getAttribute('data-label');
                    const text = cell.textContent?.trim() || '';
                    if (label) {
                        data[label] = text;
                    }
                });

                return {
                    rowCount: rows.length,
                    rowClasses: firstRow.className,
                    rowHTML: firstRow.outerHTML.substring(0, 500),
                    data
                };
            });

            log(`   [DOM] Position rows found: ${positionRowData.rowCount}`);
            if (positionRowData.rowClasses) {
                log(`   [DOM] First row classes: "${positionRowData.rowClasses}"`);
            }
            if (positionRowData.data) {
                log(`   [DOM] First row data:`);
                for (const [key, val] of Object.entries(positionRowData.data)) {
                    log(`   [DOM]   ${key}: "${val}"`);
                }
            }

            // Now read the avg fill price with the standard selector
            // Note: Coinbase uses "Avg Price", Bybit Paper uses "Avg Fill Price"
            const avgPriceSelector = IS_PROD
                ? 'td[data-label="Avg Price"] span'
                : 'td[data-label="Avg Fill Price"] span';
            log(`   [DOM] Final read with: ${avgPriceSelector}`);
            const avgFillRaw = await this.page.evaluate((selector: string) => {
                // Try the primary selector first
                let avgFillCell = document.querySelector(selector);
                // Fallback to the other format
                if (!avgFillCell) {
                    avgFillCell = document.querySelector('td[data-label="Avg Price"] span')
                        || document.querySelector('td[data-label="Avg Fill Price"] span');
                }
                return {
                    text: avgFillCell?.textContent || null,
                    exists: !!avgFillCell,
                    parentHTML: avgFillCell?.parentElement?.outerHTML?.substring(0, 300) || null
                };
            }, avgPriceSelector);
            log(`   [DOM] Avg Fill element found: ${avgFillRaw.exists}`);
            log(`   [DOM] Avg Fill raw text: "${avgFillRaw.text}"`);
            if (avgFillRaw.parentHTML) {
                log(`   [DOM] Parent HTML: ${avgFillRaw.parentHTML}`);
            }

            let entryPrice = 0;
            if (avgFillRaw.text) {
                entryPrice = parseFloat(avgFillRaw.text.replace(/,/g, ''));
                log(`   Average fill price parsed: $${entryPrice}`);
            } else if (foundAvgFill) {
                entryPrice = parseFloat(foundAvgFill.replace(/[^0-9.]/g, ''));
                log(`   ⚠️ Used fallback selector, parsed: $${entryPrice}`);
            } else {
                log("   ❌ FAILED to read avg fill price from ANY selector!");
                // Try to get ANY price from the position row data
                // Note: Coinbase uses "Avg Price" while Bybit uses "Avg Fill Price"
                const priceKeys = ['Avg Price', 'Avg Fill Price', 'Entry Price', 'Price', 'Avg. Fill'];
                const rowData = positionRowData.data as Record<string, string>;
                for (const key of priceKeys) {
                    if (rowData && rowData[key]) {
                        const parsed = parseFloat(rowData[key].replace(/[^0-9.]/g, ''));
                        if (parsed > 0) {
                            entryPrice = parsed;
                            log(`   [RECOVERY] Found price via row data key "${key}": $${entryPrice}`);
                            break;
                        }
                    }
                }
            }

            log(`   ═══ END POSITION TABLE DIAGNOSTICS ═══`);

            // Read actual filled quantity from positions table (more accurate than pre-fill estimate)
            log(`   [DOM] Reading filled qty from: td[data-label="Qty"]`);
            const filledQtyRaw = await this.page.evaluate(() => {
                // Based on HTML: <td data-label="Qty"><div class="ka-cell-text cellContent-...">246.861</div></td>
                const qtyCell = document.querySelector('td[data-label="Qty"]');
                return {
                    text: qtyCell?.textContent?.trim() || null,
                    exists: !!qtyCell
                };
            });
            log(`   [DOM] Qty element found: ${filledQtyRaw.exists}`);
            log(`   [DOM] Qty raw text: "${filledQtyRaw.text}"`);

            if (filledQtyRaw.text) {
                actualQuantity = parseFloat(filledQtyRaw.text.replace(/,/g, ''));
                log(`   Actual filled quantity: ${actualQuantity} contracts`);
            } else {
                log("   ⚠️ Could not read actual qty from positions table, using estimate");
            }

            // Read actual margin from Order History table (more accurate than positions table)
            log("   Reading margin from Order History...");
            log(`   [DOM] Clicking Order History tab: button#history`);

            // Click on Order History tab
            const orderHistoryTab = await this.page.$('button#history');
            if (orderHistoryTab) {
                await orderHistoryTab.click();
                log(`   Order History tab clicked, waiting 1.5s for table load...`);
                await this.delay(1500); // Wait longer for table to load
                log(`   Table load wait complete`);
            } else {
                log("   ⚠️ [DOM] Could not find Order History tab (button#history)");
            }

            // Find the first row with Type "Market" and extract the margin
            log(`   [DOM] Searching for Market order row in tr.ka-tr.ka-row`);
            const marginResult = await this.page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('tr.ka-tr.ka-row'));
                const results: string[] = [];
                for (const row of rows) {
                    // Try multiple selectors for Type cell (different class patterns between brokers)
                    const typeCell = row.querySelector('td[data-label="Type"]');
                    const typeText = typeCell?.textContent?.trim() || 'N/A';
                    results.push(`Row Type: "${typeText}"`);
                    if (typeText === 'Market') {
                        // Margin column - Paper trading uses "Margin", Coinbase doesn't have it
                        const marginCell = row.querySelector('td[data-label="Margin"]');
                        // Time column - Paper trading uses "Placing Time", Coinbase uses "Time Placed"
                        const placingTimeCell = row.querySelector('td[data-label="Time Placed"]')
                            || row.querySelector('td[data-label="Placing Time"]');
                        const sideCell = row.querySelector('td[data-label="Side"]');
                        return {
                            found: true,
                            marginText: marginCell?.textContent?.trim() || null,
                            placingTime: placingTimeCell?.textContent?.trim() || null,
                            side: sideCell?.textContent?.trim() || null,
                            rowTypes: results
                        };
                    }
                }
                return { found: false, marginText: null, placingTime: null, side: null, rowTypes: results };
            });

            log(`   [DOM] Rows scanned: ${marginResult.rowTypes.length}`);
            for (const rt of marginResult.rowTypes.slice(0, 5)) {
                log(`   [DOM] ${rt}`);
            }
            if (marginResult.rowTypes.length > 5) {
                log(`   [DOM] ... and ${marginResult.rowTypes.length - 5} more rows`);
            }
            log(`   [DOM] Market row found: ${marginResult.found}`);
            log(`   [DOM] Margin raw text: "${marginResult.marginText}"`);
            log(`   [DOM] Market order placing time: "${marginResult.placingTime}"`);
            log(`   [DOM] Market order side: "${marginResult.side}"`);

            if (marginResult.marginText) {
                marginAmount = parseFloat(marginResult.marginText.replace(/,/g, ''));
                log(`   Actual margin used: $${marginAmount.toLocaleString()}`);
            } else if (IS_PROD) {
                // For Coinbase prod mode, read Initial margin from Account Summary tab
                log("   [PROD] Reading margin from Account Summary tab...");
                const summaryTab = await this.page.$('button#summary');
                if (summaryTab) {
                    await summaryTab.click();
                    await this.delay(1000);
                    log("   [PROD] Account Summary tab clicked");

                    // Find the "Initial margin" row and read the Amount column
                    const initialMarginResult = await this.page.evaluate(() => {
                        const row = document.querySelector('tr[data-row-id="initialMargin"]');
                        if (!row) return { found: false, amount: null };

                        const amountCell = row.querySelector('td[data-label="Amount"] span span:first-child');
                        return {
                            found: true,
                            amount: amountCell?.textContent?.trim() || null
                        };
                    });

                    if (initialMarginResult.found && initialMarginResult.amount) {
                        marginAmount = parseFloat(initialMarginResult.amount.replace(/,/g, '')) || marginAmount;
                        log(`   [PROD] Initial margin from Account Summary: $${marginAmount.toLocaleString()}`);
                    } else {
                        log("   [PROD] ⚠️ Could not read Initial margin from Account Summary");
                    }
                } else {
                    log("   [PROD] ⚠️ Could not find Account Summary tab");
                }
            } else {
                log("   ⚠️ Could not read actual margin from Order History, using estimate");
            }

            // Check if the Market order in Order History is recent (within last 60 seconds)
            // This helps us determine if a NEW order was placed vs reading stale data
            let isMarketOrderRecent = false;
            if (marginResult.placingTime) {
                try {
                    // Format from TradingView: "2026-01-08 19:41:53"
                    const orderTime = new Date(marginResult.placingTime.replace(' ', 'T') + 'Z');
                    const now = new Date();
                    const ageSeconds = (now.getTime() - orderTime.getTime()) / 1000;
                    log(`   [DOM] Market order age: ${ageSeconds.toFixed(1)} seconds`);
                    isMarketOrderRecent = ageSeconds < 60; // Consider "recent" if within last 60 seconds
                    if (isMarketOrderRecent) {
                        log(`   ✓ Market order is recent (placed within last 60s)`);
                    } else {
                        log(`   ⚠️ Market order appears stale (older than 60s)`);
                    }
                } catch (e) {
                    log(`   ⚠️ Could not parse Market order time: ${e}`);
                }
            }

            // Go back to Positions tab
            log(`   [DOM] Clicking Positions tab: button#positions`);
            const positionsTab = await this.page.$('button#positions');
            if (positionsTab) {
                await positionsTab.click();
                await this.delay(500);
                log(`   Positions tab clicked ✓`);
            } else {
                log(`   ⚠️ [DOM] Could not find Positions tab`);
            }

            const totalTime = logger.getElapsedSeconds().toFixed(2);

            // === CRITICAL VALIDATION: Check if order actually executed ===
            // Only fail if BOTH conditions are true:
            // 1. entryPrice is 0 (no position in Positions tab)
            // 2. No recent Market order in Order History (order wasn't placed)
            if (entryPrice === 0 && !isMarketOrderRecent) {
                log(`\n❌ ORDER EXECUTION FAILED!`);
                log(`   Entry price is 0 - no position was created`);
                log(`   No recent Market order found in Order History`);
                log(`   The order button was clicked but no order was placed on the exchange`);
                log(`   This may be due to:`);
                log(`   - TradingView Paper Trading glitch`);
                log(`   - Rapid position close/open timing issue`);
                log(`   - Exchange connectivity problems`);
                log(`   Total execution time: ${totalTime}s`);
                log(`${"═".repeat(60)}\n`);

                // Refresh the page after 10 seconds to clear any stuck UI state
                log(`   🔄 Refreshing page in 10 seconds to clear UI state...`);
                await this.delay(10000);
                log(`   Refreshing page now...`);
                await this.page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
                await this.delay(2000);
                log(`   ✅ Page refreshed`);

                return {
                    success: false,
                    error: `Order failed: No position created (entry price = 0) and no recent Market order in Order History. The order button was clicked but no order was placed.`,
                    executionLogs: getLogs()
                };
            }

            // If entryPrice is 0 but we found a recent Market order, log a warning but don't fail
            // This could mean the position was immediately closed or there's a display timing issue
            if (entryPrice === 0 && isMarketOrderRecent) {
                log(`\n⚠️ WARNING: Entry price is 0 but a recent Market order was found`);
                log(`   This could indicate the position was filled but UI hasn't updated yet`);
                log(`   Or the position was immediately closed by TP/SL`);
            }

            logger.startSection('result');
            logger.success(`Order placed successfully!`);
            logger.log(`Total execution time: ${totalTime}s`);
            logger.header('ORDER COMPLETE', 'end');

            return {
                success: true,
                executionDetails: {
                    symbol: params.symbol || "ETHUSDT",
                    side: params.direction,
                    entryPrice,
                    quantity: actualQuantity,
                    marginUsed: marginAmount,
                    fee: feeAmount,
                    takeProfit: params.takeProfit,
                    stopLoss: params.stopLoss,
                    timestamp: new Date().toISOString()
                },
                executionLogs: getLogs()
            };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            // Check if this is a recoverable CDP error and we haven't retried yet
            const isCDPError = errorMsg.includes('detached Frame') ||
                errorMsg.includes('Protocol error') ||
                errorMsg.includes('Target closed') ||
                errorMsg.includes('Session closed');

            if (isCDPError && !isRetry) {
                logger.warn("CDP error during order placement. Restarting browser and retrying...");
                await this.restartBrowser();
                return this.placeMarketOrder(params, true);
            }

            logger.startSection('error');
            logger.error(`Order placement failed: ${errorMsg}`);
            logger.header('ORDER FAILED', 'error');
            return { success: false, error: errorMsg, executionLogs: getLogs() };
        }
    }

    /**
     * Get current price from chart
     */
    async getCurrentPrice(): Promise<number | null> {
        if (!this.page) return null;

        try {
            // Try to get price from various elements
            const priceElement = await this.page.$('.price-axis__price, .last-price, [data-name="current-price"]');
            if (priceElement) {
                const priceText = await priceElement.evaluate(el => el.textContent);
                if (priceText) {
                    return parseFloat(priceText.replace(/[^0-9.]/g, ''));
                }
            }
        } catch (e) {
            console.log("Could not get current price");
        }
        return null;
    }

    /**
     * Take a screenshot for debugging
     */
    async screenshot(filename: string): Promise<void> {
        if (!this.page) return;
        await this.page.screenshot({ path: filename, fullPage: true });
        console.log(`📸 Screenshot saved: ${filename}`);
    }

    /**
     * Close browser and cleanup
     */
    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            console.log("🔒 Browser closed");
        }
    }

    /**
     * Check if there's an open position
     * Returns position details if exists, null otherwise
     */
    async hasOpenPosition(): Promise<{
        hasPosition: boolean;
        position?: {
            symbol: string;
            side: string;
            qty: string;
            avgPrice: string;
            pnl: string;
        };
    }> {
        if (!this.page) {
            return { hasPosition: false };
        }

        try {
            // Ensure connection is valid
            await this.ensureConnection();

            // Click on positions tab to check
            const posTab = await this.page.$('button#positions');
            if (posTab) {
                await posTab.click();
                await this.delay(1000);
            }

            // Check if there are any open positions by looking for rows with data-row-id
            const existingPosition = await this.page.evaluate(() => {
                const positionsContainer = document.querySelector('div[data-account-manager-page-id="positions"]');
                const root = positionsContainer || document;

                const positionRows = root.querySelectorAll('tr.ka-tr.ka-row[data-row-id]');
                if (positionRows.length === 0) {
                    return null;
                }

                const firstRow = positionRows[0];
                const symbolCell = firstRow.querySelector('td[data-label="Symbol"]');
                const sideCell = firstRow.querySelector('td[data-label="Side"]');
                const qtyCell = firstRow.querySelector('td[data-label="Qty"]');
                const avgPriceCell = firstRow.querySelector('td[data-label="Avg Fill Price"]');
                const pnlCell = firstRow.querySelector('td[data-label="Unrealized P&L"]');

                return {
                    symbol: symbolCell?.textContent?.trim() || 'unknown',
                    side: sideCell?.textContent?.trim() || 'unknown',
                    qty: qtyCell?.textContent?.trim() || 'unknown',
                    avgPrice: avgPriceCell?.textContent?.trim() || 'unknown',
                    pnl: pnlCell?.textContent?.trim() || 'unknown'
                };
            });

            if (existingPosition) {
                return {
                    hasPosition: true,
                    position: existingPosition
                };
            }

            return { hasPosition: false };
        } catch (error) {
            console.error("Error checking position:", error);
            return { hasPosition: false };
        }
    }

    /**
     * Check if client is ready for trading
     */
    isReady(): boolean {
        return this.isLoggedIn && this.isBrokerConnected && this.page !== null;
    }

    /**
     * Helper delay function
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Dismiss any promotion/sale modal that might appear
     * TradingView sometimes shows promotional popups for sales
     */
    private async dismissPromotionModal(): Promise<void> {
        if (!this.page) return;

        try {
            // Check for promotion modal (e.g., "Hello 2026 sale" popup)
            // The modal has class 'modal-AIyNn2YU' and a close button with class 'closeButton-AIyNn2YU'
            const closeButton = await this.page.$('.closeButton-AIyNn2YU, button.closeButton-AIyNn2YU, .closeButtonWrapper-AIyNn2YU button');
            if (closeButton) {
                console.log("📢 Promotion modal detected, dismissing...");
                await closeButton.click();
                await this.delay(500);
                console.log("   ✅ Promotion modal closed");
            }
        } catch (e) {
            // Modal not present or already closed, continue silently
        }
    }
}

/**
 * Symbol mapping for TradingView URL format
 * TradingView uses EXCHANGE:SYMBOL format
 */
export const TV_SYMBOL_MAP: Record<string, string> = {
    "BTCUSDT": "MEXC:BTCUSDT.P",
    "ETHUSDT": "MEXC:ETHUSDT.P",
    "SOLUSDT": "MEXC:SOLUSDT.P",
    "XRPUSDT": "MEXC:XRPUSDT.P",
    "DOGEUSDT": "MEXC:DOGEUSDT.P",
};

/**
 * Build TradingView chart URL with symbol
 */
export function buildChartUrl(baseUrl: string, symbol: string): string {
    const tvSymbol = TV_SYMBOL_MAP[symbol.toUpperCase()] || `MEXC:${symbol.toUpperCase()}.P`;
    const encodedSymbol = encodeURIComponent(tvSymbol);

    // If URL already has a symbol parameter, replace it
    if (baseUrl.includes("symbol=")) {
        return baseUrl.replace(/symbol=[^&]+/, `symbol=${encodedSymbol}`);
    }

    // Otherwise append symbol parameter
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}symbol=${encodedSymbol}`;
}
