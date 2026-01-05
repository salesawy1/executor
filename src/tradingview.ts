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

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Session file path (stored in executor directory)
const SESSION_PATH = path.join(__dirname, "..", "tradingview-session.json");

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
        console.log("🚀 Launching browser...");

        this.browser = await puppeteer.launch({
            headless: this.config.headless ?? false, // Default to visible for debugging
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

        // Try to load existing session cookies
        const sessionData = this.loadSession();
        if (sessionData) {
            console.log("📂 Found existing session, restoring cookies...");
            await this.page.setCookie(...sessionData.cookies);
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
    private loadSession(): { cookies: any[] } | null {
        try {
            if (fs.existsSync(SESSION_PATH)) {
                const data = fs.readFileSync(SESSION_PATH, "utf-8");
                const session = JSON.parse(data);
                console.log(`   Session file found (saved: ${session.savedAt})`);
                return session;
            }
        } catch (e) {
            console.log("   Could not load session file");
        }
        return null;
    }

    /**
     * Save session to disk
     */
    private async saveSession(): Promise<void> {
        if (!this.page) return;
        try {
            const cookies = await this.page.cookies();
            const session = {
                cookies,
                savedAt: new Date().toISOString()
            };
            fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
            console.log("💾 Session saved to disk");
        } catch (e) {
            console.log("⚠️  Could not save session");
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

            console.log(`⚠️  Disconnect detected (${disconnectType}). Attempt ${i + 1}/3 to reconnect...`);

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
        if (!this.page) {
            if (isRetry) {
                return { success: false, error: "Browser not initialized after restart" };
            }
            console.log("⚠️  Browser not initialized. Attempting to restart...");
            await this.restartBrowser();
            return this.placeMarketOrder(params, true);
        }

        console.log(`\n${"═".repeat(60)}`);
        console.log(`📤 PLACING MARKET ORDER${isRetry ? ' (RETRY)' : ''}`);
        console.log(`${"═".repeat(60)}`);
        console.log(`   Direction: ${params.direction}`);
        console.log(`   Quantity: ${params.quantity}`);
        if (params.stopLoss) console.log(`   Stop Loss: $${params.stopLoss}`);
        if (params.takeProfit) console.log(`   Take Profit: $${params.takeProfit}`);

        try {
            // Ensure we are connected before trying to interact
            await this.ensureConnection();

            // Ensure order form is open
            await this.openOrderForm();

            // Handle auto-margin sizing if quantity is -1
            let useMarginMode = params.quantity < 0;
            let marginAmount = 0;

            if (useMarginMode) {
                console.log("   📊 Auto-sizing position from equity...");

                // Read equity from the account summary
                const equityText = await this.page.evaluate(() => {
                    const equityElement = document.querySelector('.accountSummaryField-tWnxJF90 .value-tWnxJF90');
                    return equityElement?.textContent || '0';
                });

                const equity = parseFloat(equityText.replace(/,/g, ''));
                marginAmount = Math.floor(equity * 0.9 * 100) / 100; // 90% of equity, rounded to 2 decimals

                console.log(`   Equity: $${equity.toLocaleString()}`);
                console.log(`   Using 90% margin: $${marginAmount.toLocaleString()}`);
            }

            // 1. Click the direction button FIRST (Buy or Sell)
            const sideSelector = params.direction === "LONG"
                ? '[data-name="side-control-buy"]'
                : '[data-name="side-control-sell"]';

            console.log(`   Clicking ${params.direction === "LONG" ? "BUY" : "SELL"} side...`);
            await this.page.waitForSelector(sideSelector, { timeout: 5000 });
            await this.page.click(sideSelector);
            await this.delay(500);

            // 2. Select Market order type (switch from Limit)
            console.log("   Selecting Market order type...");
            await this.page.waitForSelector('button#Market', { timeout: 5000 });
            await this.page.click('button#Market');
            await this.delay(500);

            // 2.5. Set margin amount if auto-sizing
            let actualQuantity = params.quantity;
            if (useMarginMode && marginAmount > 0) {
                console.log(`   Setting margin to $${marginAmount.toFixed(2)}...`);
                const marginInput = await this.page.$('#quantity-calculation-field');
                if (marginInput) {
                    await marginInput.click({ clickCount: 3 });
                    await this.delay(100);
                    await marginInput.type(marginAmount.toFixed(2), { delay: 100 });
                }
                await this.delay(500);

                // Read the actual quantity that was auto-calculated
                const quantityText = await this.page.evaluate(() => {
                    const qtyInput = document.querySelector('#quantity-field') as HTMLInputElement;
                    return qtyInput?.value || '0';
                });
                actualQuantity = parseFloat(quantityText.replace(/,/g, ''));
                console.log(`   Auto-calculated quantity: ${actualQuantity} contracts`);
            }

            // 3. Set Take Profit if provided
            if (params.takeProfit) {
                console.log("   Enabling take profit...");
                const tpCheckbox = await this.page.$('input[data-qa-id="order-ticket-profit-checkbox-bracket"]');
                if (tpCheckbox) {
                    await tpCheckbox.click();
                    await this.delay(300);
                }

                console.log(`   Setting take profit to ${params.takeProfit.toFixed(2)}...`);
                const tpInput = await this.page.$('#take-profit-price-field');
                if (tpInput) {
                    await tpInput.click({ clickCount: 3 });
                    await this.delay(100);
                    await tpInput.type(params.takeProfit.toFixed(2), { delay: 150 });
                }
                await this.delay(300);
            }

            // 4. Set Stop Loss if provided
            if (params.stopLoss) {
                console.log("   Enabling stop loss...");
                const slCheckbox = await this.page.$('input[data-qa-id="order-ticket-loss-checkbox-bracket"]');
                if (slCheckbox) {
                    await slCheckbox.click();
                    await this.delay(300);
                }

                console.log(`   Setting stop loss to ${params.stopLoss.toFixed(2)}...`);
                const slInput = await this.page.$('#stop-loss-price-field');
                if (slInput) {
                    await slInput.click({ clickCount: 3 });
                    await this.delay(100);
                    await slInput.type(params.stopLoss.toFixed(2), { delay: 300 });
                }
                await this.delay(300);
            }

            // 5. Click the Place Order button
            console.log("   Clicking Place Order button...");
            await this.page.waitForSelector('button[data-name="place-and-modify-button"]', { timeout: 5000 });
            await this.page.click('button[data-name="place-and-modify-button"]');

            // Wait for order to fill and position to appear
            console.log("   Waiting for order to fill...");
            await this.delay(3000);

            // Read average fill price from positions table
            const avgFillPrice = await this.page.evaluate(() => {
                const avgFillCell = document.querySelector('td[data-label="Avg Fill Price"] span');
                return avgFillCell?.textContent || null;
            });

            let entryPrice = 0;
            if (avgFillPrice) {
                entryPrice = parseFloat(avgFillPrice.replace(/,/g, ''));
                console.log(`   Average fill price: $${entryPrice}`);
            } else {
                console.log("   Could not read avg fill price from positions table");
            }

            // Read actual filled quantity from positions table (more accurate than pre-fill estimate)
            const filledQty = await this.page.evaluate(() => {
                const qtyCell = document.querySelector('td[data-label="Qty"] .cellContent-pnigL71h');
                return qtyCell?.textContent || null;
            });

            if (filledQty) {
                actualQuantity = parseFloat(filledQty.replace(/,/g, ''));
                console.log(`   Actual filled quantity: ${actualQuantity} contracts`);
            } else {
                console.log("   Could not read actual qty from positions table, using estimate");
            }

            // Read actual margin from positions table (more accurate than pre-fill estimate)
            const actualMargin = await this.page.evaluate(() => {
                const marginCell = document.querySelector('td[data-label="Margin"] .cellContent-pnigL71h span span:first-child');
                return marginCell?.textContent || null;
            });

            if (actualMargin) {
                marginAmount = parseFloat(actualMargin.replace(/,/g, ''));
                console.log(`   Actual margin used: $${marginAmount.toLocaleString()}`);
            } else {
                console.log("   Could not read actual margin from positions table, using estimate");
            }

            console.log(`\n✅ Order placed successfully!`);
            console.log(`${"═".repeat(60)}\n`);

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
                }
            };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            // Check if this is a recoverable CDP error and we haven't retried yet
            const isCDPError = errorMsg.includes('detached Frame') ||
                errorMsg.includes('Protocol error') ||
                errorMsg.includes('Target closed') ||
                errorMsg.includes('Session closed');

            if (isCDPError && !isRetry) {
                console.log("\n⚠️  CDP error during order placement. Restarting browser and retrying...");
                await this.restartBrowser();
                return this.placeMarketOrder(params, true);
            }

            console.error(`❌ Order placement failed: ${errorMsg}`);
            return { success: false, error: errorMsg };
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
