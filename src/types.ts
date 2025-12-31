/**
 * Type definitions for the Executor Service
 */

// Kraken Futures API Types
export interface KrakenOrderRequest {
    symbol: string;           // e.g., "PF_ETHUSD"
    side: "buy" | "sell";
    size: number;             // Contract quantity
    orderType: "mkt" | "lmt" | "stp" | "take_profit" | "ioc" | "post";
    limitPrice?: number;      // Required for limit orders
    stopPrice?: number;       // Required for stop/take_profit orders
    triggerSignal?: "mark" | "index" | "last";  // Which price triggers stop (default: last)
    reduceOnly?: boolean;     // Only reduce existing position
    cliOrdId?: string;        // Client order ID
}

export interface KrakenOrderResponse {
    result: "success" | "error";
    sendStatus?: {
        order_id: string;
        status: string;
        receivedTime: string;
        orderEvents: Array<{
            type: string;
            order: {
                orderId: string;
                symbol: string;
                side: string;
                quantity: number;
                filled: number;
                limitPrice?: number;
                type: string;
            };
        }>;
    };
    error?: string;
}

export interface KrakenAccountsResponse {
    result: "success" | "error";
    accounts: Record<string, {
        currency: string;
        balance: number;
        available: number;
        pnl: number;
    }>;
}

export interface KrakenPosition {
    symbol: string;
    side: "long" | "short";
    size: number;
    price: number;
    pnl: number;
    effectiveLeverage: number;
}

export interface KrakenPositionsResponse {
    result: "success" | "error";
    openPositions: KrakenPosition[];
}

// Trade Execution Request (from consensus)
export interface TradeExecutionRequest {
    symbol: string;           // e.g., "ETHUSDT" (Bybit format)
    direction: "LONG" | "SHORT";
    entryPrice?: number;      // Optional - if not provided, use market
    stopLoss?: number;
    takeProfit1?: number;
    takeProfit2?: number;
    positionSizeUSD?: number; // Position size in USD
    positionSizePercent?: number; // Or as percent of account
}

export interface TradeExecutionResponse {
    success: boolean;
    orderId?: string;
    symbol: string;
    side: "buy" | "sell";
    size: number;
    price?: number;
    error?: string;
    timestamp: string;
}
