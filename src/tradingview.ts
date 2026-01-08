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
import { IS_ALT } from './index.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
     * Check if already logged in by looking for user menu button
     */
    private async checkIfLoggedIn(): Promise<boolean> {
        if (!this.page) return false;

        try {
            // Navigate to signin page to check status
            await this.page.goto("https://www.tradingview.com/accounts/signin/", {
                waitUntil: "networkidle2",
                timeout: 30000,
            });

            await this.delay(2000);

            // Check for user menu button (logged in state)
            const userMenuButton = await this.page.$(
                '.tv-header__user-menu-button--logged, [data-name="header-user-menu-button"], button[aria-label="Open user menu"]'
            );

            if (userMenuButton) {
                console.log("✅ Already logged in (session restored)!");
                return true;
            }

            // Also check if we were redirected to home page with logged in state
            const currentUrl = this.page.url();
            if (!currentUrl.includes('/accounts/signin')) {
                // We were redirected, check for user menu on current page
                const userMenu = await this.page.$(
                    '.tv-header__user-menu-button--logged, [data-name="header-user-menu-button"]'
                );
                if (userMenu) {
                    console.log("✅ Already logged in (redirected from signin)!");
                    return true;
                }
            }

            return false;
        } catch (e) {
            console.log("   Error checking login status");
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
     * Connect to paper trading broker
     */
    private async connectPaperTradingBroker(): Promise<void> {
        if (!this.page) throw new Error("Browser not initialized");

        console.log("🔗 Connecting to paper trading broker...");

        try {
            // Wait for and click the Paper Trading broker card
            await this.page.waitForSelector('[data-broker="Paper"]', { timeout: 10000 });
            await this.page.click('[data-broker="Paper"]');
            await this.delay(1000);

            // Click the Connect button to confirm broker connection
            await this.page.waitForSelector('button[name="broker-login-submit-button"]', { timeout: 5000 });
            await this.page.click('button[name="broker-login-submit-button"]');
            await this.delay(2000);

            console.log("✅ Paper trading broker connected!");
            this.isBrokerConnected = true;
        } catch (e) {
            console.log("⚠️  Could not connect paper trading broker automatically. May need manual connection.");
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

        // After clearing modals, check if we need to reconnect to the Paper Trading broker
        // This happens when we're logged in but disconnected from the broker session
        const paperBrokerCard = await this.page.$('[data-broker="Paper"]');
        if (paperBrokerCard) {
            console.log("⚠️  Paper Trading broker disconnected. Reconnecting...");
            try {
                await paperBrokerCard.click();
                await this.delay(1000);

                // Click the Connect button to confirm broker connection
                const loginBtn = await this.page.$('button[name="broker-login-submit-button"]');
                if (loginBtn) {
                    console.log("   Clicking broker connect button...");
                    await loginBtn.click();
                    await this.delay(2000);
                }
                console.log("✅ Paper Trading broker reconnected!");
            } catch (e) {
                console.log("⚠️  Could not reconnect Paper Trading broker automatically.");
            }
        }
    }

    /**
     * Place a market order with optional TP/SL
     * Will automatically restart browser and retry once if CDP connection is lost.
     */
    async placeMarketOrder(params: OrderParams, isRetry: boolean = false): Promise<ExecutionResult> {
        // Log capture array - will be returned with result
        const logs: string[] = [];
        const startTime = Date.now();

        const log = (msg: string) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const timestamp = new Date().toISOString();
            const logLine = `[${timestamp}] [+${elapsed}s] ${msg}`;
            logs.push(logLine);
            console.log(msg);
        };

        if (!this.page) {
            if (isRetry) {
                return { success: false, error: "Browser not initialized after restart", executionLogs: logs };
            }
            log("⚠️  Browser not initialized. Attempting to restart...");
            await this.restartBrowser();
            return this.placeMarketOrder(params, true);
        }

        log(`\n${"═".repeat(60)}`);
        log(`📤 PLACING MARKET ORDER${isRetry ? ' (RETRY)' : ''}`);
        log(`${"═".repeat(60)}`);
        log(`   Direction: ${params.direction}`);
        log(`   Quantity: ${params.quantity}`);
        if (params.stopLoss) log(`   Stop Loss: $${params.stopLoss}`);
        if (params.takeProfit) log(`   Take Profit: $${params.takeProfit}`);
        log(`   Page URL: ${this.page.url()}`);

        try {
            // Ensure we are connected before trying to interact
            log("🔗 Checking connection status...");
            await this.ensureConnection();
            log("   Connection verified");

            // Dismiss any promotion modals that might block order placement
            log("🔍 Checking for promotion modals...");
            await this.dismissPromotionModal();

            // Ensure order form is open
            log("📝 Opening order form...");
            const orderFormBefore = await this.page.$('[data-name="side-control-buy"], [data-name="side-control-sell"]');
            log(`   Order form visible before: ${orderFormBefore ? 'YES' : 'NO'}`);
            await this.openOrderForm();
            const orderFormAfter = await this.page.$('[data-name="side-control-buy"], [data-name="side-control-sell"]');
            log(`   Order form visible after: ${orderFormAfter ? 'YES' : 'NO'}`);

            // Handle auto-margin sizing if quantity is -1
            let useMarginMode = params.quantity < 0;
            let marginAmount = 0;

            if (useMarginMode) {
                log("   📊 Auto-sizing position from equity...");

                // Read equity from the account summary
                const equityRaw = await this.page.evaluate(() => {
                    const equityElement = document.querySelector('.accountSummaryField-tWnxJF90 .value-tWnxJF90');
                    return {
                        text: equityElement?.textContent || '0',
                        exists: !!equityElement,
                        className: equityElement?.className || 'N/A'
                    };
                });
                log(`   [DOM] Equity element found: ${equityRaw.exists}`);
                log(`   [DOM] Equity raw text: "${equityRaw.text}"`);

                const equity = parseFloat(equityRaw.text.replace(/,/g, ''));
                marginAmount = Math.floor(equity * 0.9 * 100) / 100; // 90% of equity, rounded to 2 decimals

                log(`   Equity parsed: $${equity.toLocaleString()}`);
                log(`   Using 90% margin: $${marginAmount.toLocaleString()}`);
            }

            // 1. Click the direction button FIRST (Buy or Sell)
            const sideSelector = params.direction === "LONG"
                ? '[data-name="side-control-buy"]'
                : '[data-name="side-control-sell"]';

            log(`   Clicking ${params.direction === "LONG" ? "BUY" : "SELL"} side...`);
            log(`   [DOM] Selector: ${sideSelector}`);
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
            log(`   Side button clicked ✓`);

            // 2. Select Market order type (switch from Limit)
            log("   Selecting Market order type...");
            log(`   [DOM] Selector: button#Market`);
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
            log(`   Market order type selected ✓`);

            // 2.5. Set margin amount if auto-sizing
            let actualQuantity = params.quantity;
            if (useMarginMode && marginAmount > 0) {
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
            }

            // 3. Set Take Profit if provided
            if (params.takeProfit) {
                log("   Enabling take profit...");
                log(`   [DOM] Selector: input[data-qa-id="order-ticket-profit-checkbox-bracket"]`);
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
                log(`   Take profit set ✓`);
            }

            // 4. Set Stop Loss if provided
            if (params.stopLoss) {
                log("   Enabling stop loss...");
                log(`   [DOM] Selector: input[data-qa-id="order-ticket-loss-checkbox-bracket"]`);
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
                log(`   Stop loss set ✓`);
            }

            // 5. Click the Place Order button
            log("   Clicking Place Order button...");
            log(`   [DOM] Selector: button[data-name="place-and-modify-button"]`);
            const placeBtn = await this.page.waitForSelector('button[data-name="place-and-modify-button"]', { timeout: 5000 });
            const placeBtnState = await this.page.evaluate(() => {
                const btn = document.querySelector('button[data-name="place-and-modify-button"]') as HTMLButtonElement;
                return {
                    exists: !!btn,
                    disabled: btn?.disabled,
                    innerText: btn?.innerText || 'N/A'
                };
            });
            log(`   [DOM] Place button text: "${placeBtnState.innerText}"`);
            log(`   [DOM] Place button disabled: ${placeBtnState.disabled}`);
            await this.page.click('button[data-name="place-and-modify-button"]');
            log(`   Place Order button clicked ✓`);

            // Wait for order to fill and position to appear
            log("   Waiting for order to fill (5 seconds)...");
            await this.delay(5000);
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
            const avgFillSelectors = [
                'td[data-label="Avg Fill Price"] span',
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
            log(`   [DOM] Final read with: td[data-label="Avg Fill Price"] span`);
            const avgFillRaw = await this.page.evaluate(() => {
                const avgFillCell = document.querySelector('td[data-label="Avg Fill Price"] span');
                return {
                    text: avgFillCell?.textContent || null,
                    exists: !!avgFillCell,
                    parentHTML: avgFillCell?.parentElement?.outerHTML?.substring(0, 300) || null
                };
            });
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
                const priceKeys = ['Avg Fill Price', 'Entry Price', 'Price', 'Avg. Fill'];
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
            log(`   [DOM] Reading filled qty from: td[data-label="Qty"] .cellContent-pnigL71h`);
            const filledQtyRaw = await this.page.evaluate(() => {
                const qtyCell = document.querySelector('td[data-label="Qty"] .cellContent-pnigL71h');
                return {
                    text: qtyCell?.textContent || null,
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
                    const typeCell = row.querySelector('td[data-label="Type"] .cellContent-pnigL71h');
                    const typeText = typeCell?.textContent?.trim() || 'N/A';
                    results.push(`Row Type: "${typeText}"`);
                    if (typeText === 'Market') {
                        const marginCell = row.querySelector('td[data-label="Margin"] .cellContent-pnigL71h span span:first-child');
                        return {
                            found: true,
                            marginText: marginCell?.textContent || null,
                            rowTypes: results
                        };
                    }
                }
                return { found: false, marginText: null, rowTypes: results };
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

            if (marginResult.marginText) {
                marginAmount = parseFloat(marginResult.marginText.replace(/,/g, ''));
                log(`   Actual margin used: $${marginAmount.toLocaleString()}`);
            } else {
                log("   ⚠️ Could not read actual margin from Order History, using estimate");
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

            const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
            log(`\n✅ Order placed successfully!`);
            log(`   Total execution time: ${totalTime}s`);
            log(`${"═".repeat(60)}\n`);

            return {
                success: true,
                executionDetails: {
                    symbol: params.symbol || "ETHUSDT",
                    side: params.direction,
                    entryPrice,
                    quantity: actualQuantity,
                    marginUsed: marginAmount,
                    takeProfit: params.takeProfit,
                    stopLoss: params.stopLoss,
                    timestamp: new Date().toISOString()
                },
                executionLogs: logs
            };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            // Check if this is a recoverable CDP error and we haven't retried yet
            const isCDPError = errorMsg.includes('detached Frame') ||
                errorMsg.includes('Protocol error') ||
                errorMsg.includes('Target closed') ||
                errorMsg.includes('Session closed');

            if (isCDPError && !isRetry) {
                log("\n⚠️  CDP error during order placement. Restarting browser and retrying...");
                await this.restartBrowser();
                return this.placeMarketOrder(params, true);
            }

            log(`❌ Order placement failed: ${errorMsg}`);
            return { success: false, error: errorMsg, executionLogs: logs };
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
