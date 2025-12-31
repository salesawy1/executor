/**
 * Kraken Futures Demo API Client
 * 
 * Implements HMAC-SHA512 authentication for the Kraken Futures API.
 * Base URL for demo: https://demo-futures.kraken.com/derivatives/api/v3/
 */

import * as crypto from "crypto";
import {
    KrakenOrderRequest,
    KrakenOrderResponse,
    KrakenAccountsResponse,
    KrakenPositionsResponse,
} from "./types.js";

const DEMO_BASE_URL = "https://demo-futures.kraken.com/derivatives";

export class KrakenFuturesClient {
    private apiKey: string;
    private apiSecret: string;
    private baseUrl: string;

    constructor(apiKey: string, apiSecret: string, useLive = false) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = useLive
            ? "https://futures.kraken.com/derivatives"
            : DEMO_BASE_URL;
    }

    /**
     * Generate authentication headers for Kraken Futures API v3
     * 
     * Steps:
     * 1. Concatenate: postData + nonce + endpointPath
     * 2. SHA-256 hash the concatenated string
     * 3. Base64-decode the API secret
     * 4. HMAC-SHA512 using decoded secret on the SHA-256 hash
     * 5. Base64-encode the result
     */
    private generateAuth(
        endpointPath: string,
        postData: string = "",
        nonce: string = Date.now().toString()
    ): { APIKey: string; Authent: string; Nonce: string } {
        // Step 1: Concatenate postData + nonce + endpointPath
        const message = postData + nonce + endpointPath;

        // Step 2: SHA-256 hash
        const sha256Hash = crypto.createHash("sha256").update(message).digest();

        // Step 3: Base64-decode the API secret
        const secretBuffer = Buffer.from(this.apiSecret, "base64");

        // Step 4: HMAC-SHA512
        const hmac = crypto
            .createHmac("sha512", secretBuffer)
            .update(sha256Hash)
            .digest();

        // Step 5: Base64-encode
        const authent = hmac.toString("base64");

        return {
            APIKey: this.apiKey,
            Authent: authent,
            Nonce: nonce,
        };
    }

    /**
     * Make an authenticated request to the Kraken Futures API
     */
    private async authenticatedRequest<T>(
        method: "GET" | "POST",
        endpoint: string,
        params: Record<string, string | number | boolean> = {}
    ): Promise<T> {
        // For signature: use endpoint path WITHOUT /derivatives prefix
        const endpointPath = endpoint;
        const nonce = Date.now().toString();

        // Build query string for GET or form data for POST
        const paramString = Object.entries(params)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&");

        const auth = this.generateAuth(endpointPath, paramString, nonce);

        // For URL: use full path with /derivatives
        const url = method === "GET" && paramString
            ? `${this.baseUrl}${endpoint}?${paramString}`
            : `${this.baseUrl}${endpoint}`;

        const headers: Record<string, string> = {
            "APIKey": auth.APIKey,
            "Authent": auth.Authent,
            "Nonce": auth.Nonce,
            "Content-Type": "application/x-www-form-urlencoded",
        };

        const options: RequestInit = {
            method,
            headers,
        };

        if (method === "POST" && paramString) {
            options.body = paramString;
        }

        console.log(`🔐 ${method} ${endpoint}`);

        const response = await fetch(url, options);
        const data = await response.json();

        if (!response.ok) {
            console.error("Kraken API Error:", data);
            throw new Error(`Kraken API Error: ${JSON.stringify(data)}`);
        }

        return data as T;
    }

    /**
     * Get account balances
     */
    async getAccounts(): Promise<KrakenAccountsResponse> {
        return this.authenticatedRequest<KrakenAccountsResponse>(
            "GET",
            "/api/v3/accounts"
        );
    }

    /**
     * Get open positions
     */
    async getOpenPositions(): Promise<KrakenPositionsResponse> {
        return this.authenticatedRequest<KrakenPositionsResponse>(
            "GET",
            "/api/v3/openpositions"
        );
    }

    /**
     * Send an order
     */
    async sendOrder(order: KrakenOrderRequest): Promise<KrakenOrderResponse> {
        const params: Record<string, string | number | boolean> = {
            orderType: order.orderType,
            symbol: order.symbol,
            side: order.side,
            size: order.size,
        };

        if (order.limitPrice !== undefined) {
            params.limitPrice = order.limitPrice;
        }

        if (order.stopPrice !== undefined) {
            params.stopPrice = order.stopPrice;
            // Default to 'last' price for the trigger signal
            params.triggerSignal = order.triggerSignal || "last";
        }

        if (order.reduceOnly !== undefined) {
            params.reduceOnly = order.reduceOnly;
        }

        if (order.cliOrdId) {
            params.cliOrdId = order.cliOrdId;
        }

        console.log(`📤 Sending order:`, params);

        return this.authenticatedRequest<KrakenOrderResponse>(
            "POST",
            "/api/v3/sendorder",
            params
        );
    }

    /**
     * Cancel an order
     */
    async cancelOrder(orderId: string): Promise<any> {
        return this.authenticatedRequest(
            "POST",
            "/api/v3/cancelorder",
            { order_id: orderId }
        );
    }

    /**
     * Get instruments (contract specifications)
     */
    async getInstruments(): Promise<any> {
        const url = `${this.baseUrl}/api/v3/instruments`;
        const response = await fetch(url);
        return response.json();
    }

    /**
     * Get ticker for a symbol (public endpoint, no auth needed)
     */
    async getTicker(symbol: string): Promise<any> {
        const url = `${this.baseUrl}/api/v3/tickers?symbol=${symbol}`;
        const response = await fetch(url);
        return response.json();
    }
}

/**
 * Symbol mapping from Bybit format to Kraken Futures format
 */
export const SYMBOL_MAP: Record<string, string> = {
    "BTCUSDT": "PF_XBTUSD",
    "ETHUSDT": "PF_ETHUSD",
    "SOLUSDT": "PF_SOLUSD",
    "XRPUSDT": "PF_XRPUSD",
    "DOGEUSDT": "PF_DOGEUSD",
    "ADAUSDT": "PF_ADAUSD",
    "LINKUSDT": "PF_LINKUSD",
    "AVAXUSDT": "PF_AVAXUSD",
    "MATICUSDT": "PF_MATICUSD",
    "DOTUSDT": "PF_DOTUSD",
};

/**
 * Convert Bybit symbol to Kraken symbol
 */
export function mapSymbol(bybitSymbol: string): string {
    const krakenSymbol = SYMBOL_MAP[bybitSymbol.toUpperCase()];
    if (!krakenSymbol) {
        throw new Error(`Unknown symbol: ${bybitSymbol}. Supported: ${Object.keys(SYMBOL_MAP).join(", ")}`);
    }
    return krakenSymbol;
}
