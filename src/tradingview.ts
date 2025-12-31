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

export interface TradingViewConfig {
    email: string;
    password: string;
    chartUrl: string;
    headless?: boolean;
}

export interface OrderParams {
    direction: "LONG" | "SHORT";
    quantity: number;
    stopLoss?: number;
    takeProfit?: number;
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

        this.page = await this.browser.newPage();

        // Set user agent to avoid detection
        await this.page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        await this.login();
        await this.navigateToChart();
        await this.connectPaperTradingBroker();
    }

    /**
     * Login to TradingView
     */
    private async login(): Promise<void> {
        if (!this.page) throw new Error("Browser not initialized");

        console.log("🔐 Logging into TradingView...");

        // Navigate to TradingView login
        await this.page.goto("https://www.tradingview.com/accounts/signin/", {
            waitUntil: "networkidle2",
            timeout: 30000,
        });

        // Wait for page to load
        await this.delay(2000);

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
     * Place a market order with optional TP/SL
     */
    async placeMarketOrder(params: OrderParams): Promise<{ success: boolean; error?: string }> {
        if (!this.page) throw new Error("Browser not initialized");

        console.log(`\n${"═".repeat(60)}`);
        console.log(`📤 PLACING MARKET ORDER`);
        console.log(`${"═".repeat(60)}`);
        console.log(`   Direction: ${params.direction}`);
        console.log(`   Quantity: ${params.quantity}`);
        if (params.stopLoss) console.log(`   Stop Loss: $${params.stopLoss}`);
        if (params.takeProfit) console.log(`   Take Profit: $${params.takeProfit}`);

        try {
            // Check for session disconnect and reconnect if needed
            const disconnectType = await this.page.evaluate(() => {
                const bodyText = document.body.innerText;
                if (bodyText.includes('Your session ended because your account was accessed from another browser')) {
                    return 'ACCOUNT_ACCESSED';
                }
                const closedTitle = document.querySelector('.title-qAW2FX1Z');
                if (closedTitle && closedTitle.textContent?.includes("We've closed this connection")) {
                    return 'CONNECTION_CLOSED';
                }
                return null;
            });

            if (disconnectType) {
                console.log(`⚠️  Disconnect detected: ${disconnectType}. Reconnecting...`);
                // Try original selectors + new data-qa-id selector
                const connectBtn = await this.page.$('.wrapperButton-yXyW_CNE button, button.button-Z0XMhbiI, button[data-qa-id="close_paywall_button"]');

                if (connectBtn) {
                    await connectBtn.click();
                    await this.delay(2000);
                    console.log("✅ Reconnected!");
                }
            }

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
            if (useMarginMode && marginAmount > 0) {
                console.log(`   Setting margin to $${marginAmount.toFixed(2)}...`);
                const marginInput = await this.page.$('#quantity-calculation-field');
                if (marginInput) {
                    await marginInput.click({ clickCount: 3 });
                    await this.delay(100);
                    await marginInput.type(marginAmount.toFixed(2), { delay: 100 });
                }
                await this.delay(300);
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
                    await tpInput.type(params.takeProfit.toFixed(2), { delay: 100 });
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
                    await slInput.type(params.stopLoss.toFixed(2), { delay: 100 });
                }
                await this.delay(300);
            }

            // 5. Click the Place Order button
            console.log("   Clicking Place Order button...");
            await this.page.waitForSelector('button[data-name="place-and-modify-button"]', { timeout: 5000 });
            await this.page.click('button[data-name="place-and-modify-button"]');
            await this.delay(2000);

            console.log(`\n✅ Order placed successfully!`);
            console.log(`${"═".repeat(60)}\n`);

            return { success: true };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
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
