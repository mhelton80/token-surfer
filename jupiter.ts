/**
 * Token-Surfer V6 — Jupiter DEX Integration
 * 
 * Handles price quotes and swap execution via Jupiter's Swap API.
 * Token-agnostic: uses mints from token-config.ts.
 * 
 * Supports:
 *   - Public Jupiter API (api.jup.ag/swap/v1)
 *   - QuickNode Metis (your-endpoint.quiknode.pro/...)
 *   - Any self-hosted Jupiter API
 */

import {
  TOKEN_MINT, USDC_MINT, TOKEN_DECIMALS, TOKEN_UNIT, USDC_UNIT,
  PRICE_PROBE_AMOUNT, MAX_SLIPPAGE_BPS, TOKEN_SYMBOL,
  JUPITER_API_URL, JUPITER_API_KEY,
} from "./token-config.js";

// Jupiter API base URL and auth
const JUPITER_BASE = JUPITER_API_URL;

function jupiterHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (JUPITER_API_KEY) h["x-api-key"] = JUPITER_API_KEY;
  return h;
}

export interface QuoteResult {
  priceUsdcPerToken: number;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  routePlan: any[];
  raw: any;
}

/**
 * Get a price quote for TOKEN → USDC (for price discovery)
 */
export async function getTokenPrice(): Promise<number> {
  const params = new URLSearchParams({
    inputMint:  TOKEN_MINT,
    outputMint: USDC_MINT,
    amount:     PRICE_PROBE_AMOUNT.toString(),
    slippageBps: "50",
    restrictIntermediateTokens: "true",
  });

  const res = await fetch(`${JUPITER_BASE}/quote?${params}`, {
    headers: jupiterHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  
  const inAmt  = Number(data.inAmount) / TOKEN_UNIT;
  const outAmt = Number(data.outAmount) / USDC_UNIT;
  return outAmt / inAmt;
}

/**
 * Get a quote for USDC → TOKEN (buying / entering position)
 */
export async function getBuyQuote(usdcAmount: number): Promise<QuoteResult> {
  const rawUsdc = Math.floor(usdcAmount * USDC_UNIT);
  const params = new URLSearchParams({
    inputMint:   USDC_MINT,
    outputMint:  TOKEN_MINT,
    amount:      rawUsdc.toString(),
    slippageBps: MAX_SLIPPAGE_BPS.toString(),
    restrictIntermediateTokens: "true",
  });

  const res = await fetch(`${JUPITER_BASE}/quote?${params}`, {
    headers: jupiterHeaders(),
  });
  if (!res.ok) throw new Error(`Jupiter buy quote failed: ${res.status}`);
  const data = await res.json();

  return {
    priceUsdcPerToken: usdcAmount / (Number(data.outAmount) / TOKEN_UNIT),
    inAmount:  data.inAmount,
    outAmount: data.outAmount,
    priceImpactPct: Number(data.priceImpactPct ?? 0),
    routePlan: data.routePlan ?? [],
    raw: data,
  };
}

/**
 * Get a quote for TOKEN → USDC (selling / exiting position)
 */
export async function getSellQuote(tokenAmount: number): Promise<QuoteResult> {
  const rawToken = Math.floor(tokenAmount * TOKEN_UNIT);
  const params = new URLSearchParams({
    inputMint:   TOKEN_MINT,
    outputMint:  USDC_MINT,
    amount:      rawToken.toString(),
    slippageBps: MAX_SLIPPAGE_BPS.toString(),
    restrictIntermediateTokens: "true",
  });

  const res = await fetch(`${JUPITER_BASE}/quote?${params}`, {
    headers: jupiterHeaders(),
  });
  if (!res.ok) throw new Error(`Jupiter sell quote failed: ${res.status}`);
  const data = await res.json();

  return {
    priceUsdcPerToken: (Number(data.outAmount) / USDC_UNIT) / tokenAmount,
    inAmount:  data.inAmount,
    outAmount: data.outAmount,
    priceImpactPct: Number(data.priceImpactPct ?? 0),
    routePlan: data.routePlan ?? [],
    raw: data,
  };
}

/**
 * Execute a swap using a Jupiter quote.
 * Returns the serialized transaction (base64) for signing.
 */
export async function getSwapTransaction(
  quoteResponse: any,
  userPublicKey: string,
): Promise<string> {
  const res = await fetch(`${JUPITER_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jupiterHeaders() },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter swap failed: ${res.status} — ${body}`);
  }

  const data = await res.json();
  return data.swapTransaction;
}

/**
 * Fetch historical price data from CoinGecko for backfill.
 * Returns hourly OHLC-like data for warmup.
 */
export async function fetchCoinGeckoHistory(
  coingeckoId: string,
  days: number = 14,
): Promise<Array<{ t: number; o: number; h: number; l: number; c: number }>> {
  const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/ohlc?vs_currency=usd&days=${days}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[CoinGecko] Backfill failed: ${res.status}. Starting cold.`);
    return [];
  }
  const data: number[][] = await res.json();
  
  // CoinGecko returns [timestamp, open, high, low, close]
  return data.map((d) => ({
    t: Math.floor(d[0] / 1000),   // ms → seconds
    o: d[1],
    h: d[2],
    l: d[3],
    c: d[4],
  }));
}
