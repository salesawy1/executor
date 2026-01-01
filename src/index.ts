/**
 * Executor Service - TradingView Edition
 * 
 * Express HTTP server that receives trade commands and executes them
 * via TradingView Paper Trading using Puppeteer automation.
 * 
 * Endpoints:
 *   POST /trade            - Execute a trade
 *   POST /execute-consensus - Execute from trade_execution.json
 *   GET  /health           - Health check
 *   GET  /screenshot       - Take screenshot of current state
 */

import * as dotenv from "dotenv";
import express, { Request, Response } from "express";
import { TradingViewClient, buildChartUrl } from "./tradingview.js";
import { TradeExecutionRequest, TradeExecutionResponse } from "./types.js";

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3001;

// TradingView credentials
const tvEmail = process.env.TRADINGVIEW_EMAIL;
const tvPassword = process.env.TRADINGVIEW_PASSWORD;
const tvChartUrl = process.env.TRADINGVIEW_CHART_URL || "https://www.tradingview.com/chart/2hWy6ct3/?symbol=MEXC%3AETHUSDT.P";
const headless = process.env.HEADLESS === "true";

// Parse CLI args for test mode
const args = process.argv.slice(2);
const testMode = args.includes("--test") || args.includes("test=true") || process.env.TEST_MODE === "true";

if (!tvEmail || !tvPassword) {
    console.error("❌ Missing required environment variables:");
    console.error("   TRADINGVIEW_EMAIL");
    console.error("   TRADINGVIEW_PASSWORD");
    process.exit(1);
}

// Initialize TradingView client
let tvClient: TradingViewClient | null = null;
let initializationPromise: Promise<void> | null = null;

async function initializeClient(): Promise<void> {
    if (tvClient?.isReady()) return;

    if (initializationPromise) {
        await initializationPromise;
        return;
    }

    initializationPromise = (async () => {
        console.log("🚀 Initializing TradingView client...");
        tvClient = new TradingViewClient({
            email: tvEmail!,
            password: tvPassword!,
            chartUrl: tvChartUrl,
            headless,
        });
        await tvClient.initialize();

        // Pre-open order form so it's ready
        console.log("📝 Preparing order form...");
        await tvClient.prepareOrderForm();

        console.log("✅ TradingView client ready!");
    })();

    await initializationPromise;
}

// Create Express app
const app = express();
app.use(express.json());

// ============================================================================
// ENDPOINTS
// ============================================================================

/**
 * Health Check
 */
app.get("/health", (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        service: "executor-tradingview",
        environment: "paper",
        clientReady: tvClient?.isReady() ?? false,
        chartUrl: tvChartUrl,
        timestamp: new Date().toISOString(),
    });
});

/**
 * Take Screenshot
 */
app.get("/screenshot", async (_req: Request, res: Response) => {
    try {
        if (!tvClient?.isReady()) {
            res.status(503).json({
                error: true,
                message: "TradingView client not ready",
            });
            return;
        }

        const filename = `screenshot_${Date.now()}.png`;
        await tvClient.screenshot(filename);
        res.json({
            success: true,
            filename,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Error taking screenshot:", error);
        res.status(500).json({
            error: true,
            message: error instanceof Error ? error.message : String(error),
        });
    }
});

/**
 * Execute Trade
 * 
 * Request body:
 * {
 *   "symbol": "ETHUSDT",
 *   "direction": "LONG",
 *   "size": 0.1,
 *   "stopLoss": 3000,
 *   "takeProfit": 3500
 * }
 */
app.post("/trade", async (req: Request, res: Response) => {
    try {
        await initializeClient();

        if (!tvClient?.isReady()) {
            res.status(503).json({
                success: false,
                error: "TradingView client not ready",
            });
            return;
        }

        const {
            symbol,
            direction,
            size = 1,
            stopLoss,
            takeProfit,
        }: TradeExecutionRequest & { size?: number; stopLoss?: number; takeProfit?: number } = req.body;

        if (!symbol || !direction) {
            res.status(400).json({
                success: false,
                error: "Missing required fields: symbol, direction",
            });
            return;
        }

        console.log(`\n📊 Trade Request:`);
        console.log(`   Symbol: ${symbol}`);
        console.log(`   Direction: ${direction}`);
        console.log(`   Size: ${size}`);
        if (stopLoss) console.log(`   Stop Loss: ${stopLoss}`);
        if (takeProfit) console.log(`   Take Profit: ${takeProfit}`);

        // Place order via Puppeteer
        const result = await tvClient.placeMarketOrder({
            direction: direction as "LONG" | "SHORT",
            quantity: size,
            stopLoss,
            takeProfit,
        });

        const response: TradeExecutionResponse = {
            success: result.success,
            symbol,
            side: direction === "LONG" ? "buy" : "sell",
            size,
            price: await tvClient.getCurrentPrice() || undefined,
            timestamp: new Date().toISOString(),
        };

        if (!result.success) {
            response.error = result.error;
        }

        res.json(response);
    } catch (error) {
        console.error("Error executing trade:", error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
        });
    }
});

/**
 * Execute from trade_execution.json format (Full Trade Setup)
 * 
 * Accepts the direct output from consensus trade_execution.json.
 * 
 * Request body: trade_execution.json content
 */
app.post("/execute-consensus", async (req: Request, res: Response) => {
    try {
        await initializeClient();

        if (!tvClient?.isReady()) {
            res.status(503).json({
                success: false,
                error: "TradingView client not ready",
            });
            return;
        }

        const {
            symbol,
            verdict,
            tradeSetup,
            confidence,
        } = req.body;

        // Check query param for size override (-1 means auto-size from equity)
        const sizeParam = req.query.size as string;
        const parsedSize = sizeParam ? parseFloat(sizeParam) : -1;
        const size = isNaN(parsedSize) ? -1 : parsedSize; // Handle NaN -> auto-margin mode

        if (!verdict || verdict === "NO_TRADE" || verdict === "UNCERTAINTY") {
            res.json({
                success: false,
                message: `No trade to execute (verdict: ${verdict})`,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        if (!tradeSetup) {
            res.status(400).json({
                success: false,
                error: "Missing tradeSetup in request",
            });
            return;
        }

        const direction = tradeSetup.direction as "LONG" | "SHORT";

        console.log(`\n${"═".repeat(60)}`);
        console.log(`🏛️ CONSENSUS TRADE EXECUTION (TradingView)`);
        console.log(`${"═".repeat(60)}`);
        console.log(`   Symbol: ${symbol}`);
        console.log(`   Verdict: ${verdict}`);
        console.log(`   Direction: ${direction}`);
        console.log(`   Confidence: ${confidence}%`);
        console.log(`   Size: ${size === -1 ? 'AUTO (90% equity)' : size}`);
        console.log(`   Entry Price: $${tradeSetup.entryPrice}`);
        console.log(`   Stop Loss: $${tradeSetup.stopLoss}`);
        console.log(`   Take Profit: $${tradeSetup.takeProfit1}`);

        // Place order via Puppeteer
        const result = await tvClient.placeMarketOrder({
            direction,
            quantity: size,
            stopLoss: tradeSetup.stopLoss,
            takeProfit: tradeSetup.takeProfit1,
        });

        const currentPrice = await tvClient.getCurrentPrice();

        console.log(`\n${"═".repeat(60)}`);
        if (result.success) {
            console.log(`✅ TRADE SETUP COMPLETE`);
        } else {
            console.log(`❌ TRADE SETUP FAILED: ${result.error}`);
        }
        console.log(`${"═".repeat(60)}\n`);

        res.json({
            success: result.success,
            symbol,
            direction,
            side: direction === "LONG" ? "buy" : "sell",
            size,
            currentPrice,
            consensus: {
                verdict,
                confidence,
                entry: tradeSetup.entryPrice,
                stopLoss: tradeSetup.stopLoss,
                takeProfit: tradeSetup.takeProfit1,
            },
            executionDetails: result.executionDetails || null,
            error: result.error,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Error executing consensus trade:", error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
        });
    }
});

/**
 * Navigate to a different symbol
 */
app.post("/navigate", async (req: Request, res: Response) => {
    try {
        const { symbol } = req.body;

        if (!symbol) {
            res.status(400).json({
                success: false,
                error: "Missing symbol parameter",
            });
            return;
        }

        // Build new chart URL with symbol
        const newUrl = buildChartUrl(tvChartUrl, symbol);

        // Reinitialize with new URL
        if (tvClient) {
            await tvClient.close();
        }

        tvClient = new TradingViewClient({
            email: tvEmail!,
            password: tvPassword!,
            chartUrl: newUrl,
            headless,
        });
        await tvClient.initialize();

        res.json({
            success: true,
            symbol,
            chartUrl: newUrl,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Error navigating:", error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
        });
    }
});

/**
 * Graceful shutdown
 */
process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down...");
    if (tvClient) {
        await tvClient.close();
    }
    process.exit(0);
});

process.on("SIGTERM", async () => {
    console.log("\n🛑 Shutting down...");
    if (tvClient) {
        await tvClient.close();
    }
    process.exit(0);
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                     🚀 EXECUTOR SERVICE (TradingView)                        ║
║                         Paper Trading via Puppeteer                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

  🌐 Server running on http://localhost:${PORT}
  
  📊 Chart URL: ${tvChartUrl}
  🤖 Headless: ${headless}
  
  📡 Endpoints:
     GET  /health            - Health check
     GET  /screenshot        - Take screenshot
     POST /trade             - Execute a trade
     POST /execute-consensus - Execute from trade_execution.json
     POST /navigate          - Navigate to different symbol

  📝 Example usage:
     curl http://localhost:${PORT}/health
     curl -X POST http://localhost:${PORT}/trade \\
       -H "Content-Type: application/json" \\
       -d '{"symbol":"ETHUSDT","direction":"LONG","size":1,"stopLoss":3000,"takeProfit":3500}'

  ⏳ Initializing TradingView client...
`);

    // Initialize client on startup
    try {
        await initializeClient();
        console.log(`\n  ✅ Ready to trade! Browser is open and order form is prepared.\n`);

        // Run test trade if --test flag is set
        if (testMode && tvClient) {
            console.log(`\n${'═'.repeat(60)}`);
            console.log(`🧪 TEST MODE: Running mock trade...`);
            console.log(`${'═'.repeat(60)}`);
            console.log(`   Direction: SHORT`);
            console.log(`   Quantity: AUTO (90% equity)`);
            console.log(`   Take Profit: $2960`);
            console.log(`   Stop Loss: $3050`);
            console.log(`${'═'.repeat(60)}\n`);

            const result = await tvClient.placeMarketOrder({
                direction: "SHORT",
                quantity: -1,
                takeProfit: 2960,
                stopLoss: 3050,
            });

            if (result.success) {
                console.log(`\n  🎉 TEST TRADE SUCCESSFUL!\n`);
            } else {
                console.log(`\n  ❌ TEST TRADE FAILED: ${result.error}\n`);
            }
        }
    } catch (error) {
        console.error(`\n  ❌ Failed to initialize TradingView client:`, error);
        console.log(`  ⚠️  You can still try to trade - client will retry on first request.\n`);
    }
});
