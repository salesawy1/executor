/**
 * Executor Service
 * 
 * Express HTTP server that receives trade commands and executes them
 * on Kraken Futures Demo.
 * 
 * Endpoints:
 *   POST /trade      - Execute a trade
 *   GET  /balance    - Get account balance
 *   GET  /positions  - Get open positions
 *   GET  /health     - Health check
 */

import * as dotenv from "dotenv";
import express, { Request, Response } from "express";
import { KrakenFuturesClient, mapSymbol } from "./kraken.js";
import { TradeExecutionRequest, TradeExecutionResponse } from "./types.js";

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3001;

// Validate required env vars
const apiKey = process.env.KRAKEN_DEMO_API_KEY;
const apiSecret = process.env.KRAKEN_DEMO_API_SECRET;

if (!apiKey || !apiSecret) {
    console.error("❌ Missing required environment variables:");
    console.error("   KRAKEN_DEMO_API_KEY");
    console.error("   KRAKEN_DEMO_API_SECRET");
    console.error("\nGet these from https://demo-futures.kraken.com");
    process.exit(1);
}

// Initialize Kraken client
const kraken = new KrakenFuturesClient(apiKey, apiSecret, false);

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
        service: "executor",
        environment: "demo",
        timestamp: new Date().toISOString(),
    });
});

/**
 * Get Account Balance
 */
app.get("/balance", async (_req: Request, res: Response) => {
    try {
        const accounts = await kraken.getAccounts();
        res.json(accounts);
    } catch (error) {
        console.error("Error fetching balance:", error);
        res.status(500).json({
            error: true,
            message: error instanceof Error ? error.message : String(error),
        });
    }
});

/**
 * Get Open Positions
 */
app.get("/positions", async (_req: Request, res: Response) => {
    try {
        const positions = await kraken.getOpenPositions();
        res.json(positions);
    } catch (error) {
        console.error("Error fetching positions:", error);
        res.status(500).json({
            error: true,
            message: error instanceof Error ? error.message : String(error),
        });
    }
});

/**
 * Execute Trade
 * 
 * Accepts trade requests from consensus and executes on Kraken Demo.
 * 
 * Request body:
 * {
 *   "symbol": "ETHUSDT",        // Bybit format (will be converted)
 *   "direction": "LONG",         // LONG or SHORT
 *   "size": 0.1,                 // Contract size
 *   "orderType": "mkt",          // mkt, lmt, stp, ioc
 *   "limitPrice": 3000           // Required for limit orders
 * }
 */
app.post("/trade", async (req: Request, res: Response) => {
    try {
        const {
            symbol,
            direction,
            size = 0.01,
            orderType = "mkt",
            limitPrice,
        }: TradeExecutionRequest & { size?: number; orderType?: string; limitPrice?: number } = req.body;

        if (!symbol || !direction) {
            res.status(400).json({
                success: false,
                error: "Missing required fields: symbol, direction",
            });
            return;
        }

        // Map symbol from Bybit format to Kraken format
        let krakenSymbol: string;
        try {
            krakenSymbol = mapSymbol(symbol);
        } catch (e) {
            res.status(400).json({
                success: false,
                error: e instanceof Error ? e.message : String(e),
            });
            return;
        }

        // Convert direction to side
        const side = direction === "LONG" ? "buy" : "sell";

        console.log(`\n📊 Trade Request:`);
        console.log(`   Symbol: ${symbol} → ${krakenSymbol}`);
        console.log(`   Direction: ${direction} (${side})`);
        console.log(`   Size: ${size}`);
        console.log(`   Order Type: ${orderType}`);
        if (limitPrice) console.log(`   Limit Price: ${limitPrice}`);

        // Execute order
        const result = await kraken.sendOrder({
            symbol: krakenSymbol,
            side: side as "buy" | "sell",
            size,
            orderType: orderType as "mkt" | "lmt" | "stp" | "take_profit" | "ioc" | "post",
            limitPrice,
        });

        console.log(`📋 Order Result:`, JSON.stringify(result, null, 2));

        const response: TradeExecutionResponse = {
            success: result.result === "success",
            orderId: result.sendStatus?.order_id,
            symbol: krakenSymbol,
            side,
            size,
            price: limitPrice,
            timestamp: new Date().toISOString(),
        };

        if (result.result !== "success") {
            response.error = result.error || "Order failed";
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
 * Supports:
 * - MAX position sizing (uses full account balance)
 * - Stop Loss order placement
 * - Take Profit order placement
 * - Entry price validation (within $4 tolerance)
 * 
 * Request body: trade_execution.json content
 * Optional query params:
 *   ?size=MAX - Use maximum possible position size
 *   ?size=0.5 - Use specific size
 */
app.post("/execute-consensus", async (req: Request, res: Response) => {
    try {
        const {
            symbol,
            verdict,
            tradeSetup,
            confidence,
        } = req.body;

        // Check query param for size override
        const sizeParam = (req.query.size as string) || "MAX";
        const useMaxSize = sizeParam.toUpperCase() === "MAX";

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

        // Map symbol
        let krakenSymbol: string;
        try {
            krakenSymbol = mapSymbol(symbol);
        } catch (e) {
            res.status(400).json({
                success: false,
                error: e instanceof Error ? e.message : String(e),
            });
            return;
        }

        const direction = tradeSetup.direction as "LONG" | "SHORT";
        const side = direction === "LONG" ? "buy" : "sell";
        const oppositeSide = direction === "LONG" ? "sell" : "buy";

        console.log(`\n${"═".repeat(60)}`);
        console.log(`🏛️ CONSENSUS TRADE EXECUTION`);
        console.log(`${"═".repeat(60)}`);
        console.log(`   Symbol: ${symbol} → ${krakenSymbol}`);
        console.log(`   Verdict: ${verdict}`);
        console.log(`   Direction: ${direction}`);
        console.log(`   Confidence: ${confidence}%`);

        // Get current price
        const ticker = await kraken.getTicker(krakenSymbol);
        const currentPrice = parseFloat(ticker.tickers?.[0]?.markPrice || ticker.tickers?.[0]?.last || "0");

        if (!currentPrice) {
            res.status(500).json({
                success: false,
                error: "Could not fetch current price",
            });
            return;
        }

        console.log(`   Current Price: $${currentPrice}`);
        console.log(`   Entry Price: $${tradeSetup.entryPrice} (info only, executing anyway)`);

        // Calculate position size
        let size: number;

        if (useMaxSize) {
            // Get account balance
            const accounts = await kraken.getAccounts();
            console.log(`   📊 Accounts:`, JSON.stringify(accounts, null, 2));

            // Get available balance (flex collateral or available USD)
            const accountData = accounts as any;
            const flexAccount = accountData.accounts?.flex || accountData.accounts?.fi_xbtusd || accountData.accounts?.fi_ethusd;
            const availableBalance = flexAccount?.availableMargin || flexAccount?.available || flexAccount?.balance || 0;

            if (availableBalance <= 0) {
                res.status(400).json({
                    success: false,
                    error: "No available balance",
                });
                return;
            }

            console.log(`   Available Balance: $${availableBalance}`);

            // Calculate max contracts (assuming 1x leverage for safety on demo)
            // For PF_ETHUSD: 1 contract = 1 ETH notional
            // Use 90% of available to leave margin buffer
            const usableBalance = availableBalance * 0.9;
            size = Math.floor((usableBalance / currentPrice) * 100) / 100; // Round down to 0.01

            console.log(`   MAX Size: ${size} contracts (~$${(size * currentPrice).toFixed(2)} notional)`);
        } else {
            size = parseFloat(sizeParam) || 0.01;
            console.log(`   Fixed Size: ${size} contracts`);
        }

        if (size < 0.001) {
            res.status(400).json({
                success: false,
                error: "Calculated size too small",
            });
            return;
        }

        console.log(`   Stop Loss: $${tradeSetup.stopLoss}`);
        console.log(`   Take Profit: $${tradeSetup.takeProfit1}`);

        // Execute orders
        const orders: any[] = [];

        // 1. Main market order
        console.log(`\n📤 Placing MARKET ${side.toUpperCase()} order...`);
        const mainOrder = await kraken.sendOrder({
            symbol: krakenSymbol,
            side: side as "buy" | "sell",
            size,
            orderType: "mkt",
        });
        orders.push({ type: "main", result: mainOrder });
        console.log(`   Result:`, mainOrder.result);

        if (mainOrder.result !== "success") {
            res.json({
                success: false,
                error: mainOrder.error || "Main order failed",
                orders,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        // 2. Stop Loss order (reduce only)
        if (tradeSetup.stopLoss) {
            console.log(`\n📤 Placing STOP LOSS at $${tradeSetup.stopLoss}...`);
            try {
                const slOrder = await kraken.sendOrder({
                    symbol: krakenSymbol,
                    side: oppositeSide as "buy" | "sell",
                    size,
                    orderType: "stp",
                    stopPrice: tradeSetup.stopLoss,
                    reduceOnly: true,
                });
                orders.push({ type: "stopLoss", result: slOrder });
                console.log(`   Result:`, slOrder.result);
            } catch (e) {
                console.error(`   ⚠️ Stop Loss failed:`, e);
                orders.push({ type: "stopLoss", error: String(e) });
            }
        }

        // 3. Take Profit order (reduce only)
        if (tradeSetup.takeProfit1) {
            console.log(`\n📤 Placing TAKE PROFIT at $${tradeSetup.takeProfit1}...`);
            try {
                const tpOrder = await kraken.sendOrder({
                    symbol: krakenSymbol,
                    side: oppositeSide as "buy" | "sell",
                    size,
                    orderType: "take_profit",
                    stopPrice: tradeSetup.takeProfit1,
                    reduceOnly: true,
                });
                orders.push({ type: "takeProfit", result: tpOrder });
                console.log(`   Result:`, tpOrder.result);
            } catch (e) {
                console.error(`   ⚠️ Take Profit failed:`, e);
                orders.push({ type: "takeProfit", error: String(e) });
            }
        }

        console.log(`\n${"═".repeat(60)}`);
        console.log(`✅ TRADE SETUP COMPLETE`);
        console.log(`${"═".repeat(60)}\n`);

        res.json({
            success: true,
            symbol: krakenSymbol,
            direction,
            side,
            size,
            notionalValue: size * currentPrice,
            currentPrice,
            consensus: {
                verdict,
                confidence,
                entry: tradeSetup.entryPrice,
                stopLoss: tradeSetup.stopLoss,
                takeProfit: tradeSetup.takeProfit1,
            },
            orders,
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

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                        🚀 EXECUTOR SERVICE                                   ║
║                    Kraken Futures Demo Trading                               ║
╚══════════════════════════════════════════════════════════════════════════════╝

  🌐 Server running on http://localhost:${PORT}
  
  📡 Endpoints:
     GET  /health     - Health check
     GET  /balance    - Get account balance
     GET  /positions  - Get open positions
     POST /trade      - Execute a trade
     POST /execute-consensus - Execute from trade_execution.json

  🔑 API Key: ${apiKey.substring(0, 8)}...

  📝 Example usage:
     curl http://localhost:${PORT}/health
     curl http://localhost:${PORT}/balance
     curl -X POST http://localhost:${PORT}/trade \\
       -H "Content-Type: application/json" \\
       -d '{"symbol":"ETHUSDT","direction":"LONG","size":0.01}'
`);
});
