/**
 * Token-Surfer V6 — Token-Agnostic Configuration
 * 
 * All token-specific values come from environment variables.
 * Deploy the same codebase for RAY, JUP, or any Solana SPL token
 * by changing the .env file.
 */

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined ? Number(v) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

// ─── Token Identity ───────────────────────────────────────────
export const TOKEN_SYMBOL   = envStr("TOKEN_SYMBOL", "SOL");
export const TOKEN_MINT     = envStr("TOKEN_MINT", "So11111111111111111111111111111111111111112");
export const TOKEN_DECIMALS = envNum("TOKEN_DECIMALS", 9);
export const TOKEN_UNIT     = 10 ** TOKEN_DECIMALS;    // replaces LAMPORTS_PER_SOL
export const USDC_MINT      = envStr("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS  = 6;
export const USDC_UNIT      = 10 ** USDC_DECIMALS;

// Probe amounts for Jupiter quotes (raw token units as bigint)
export const PRICE_PROBE_AMOUNT     = BigInt(envStr("PRICE_PROBE_AMOUNT", "1000000"));
export const LIQUIDITY_PROBE_AMOUNT = BigInt(envStr("LIQUIDITY_PROBE_AMOUNT", "100000000"));

// ─── Timeframe ────────────────────────────────────────────────
export const BAR_MS              = envNum("BAR_MS", 3_600_000);        // 1H default
export const SAMPLE_INTERVAL_MS = envNum("SAMPLE_INTERVAL_MS", 15_000); // 15s price poll

// ─── Indicators ───────────────────────────────────────────────
export const EMA_FAST_LEN = envNum("EMA_FAST_LEN", 14);
export const EMA_SLOW_LEN = envNum("EMA_SLOW_LEN", 50);
export const ATR_LEN      = envNum("ATR_LEN", 14);

// ─── Entry Zones ──────────────────────────────────────────────
export const ZONE_ATR_MULT   = envNum("ZONE_ATR_MULT", 0.5);
export const MIN_EMA_SLOPE   = envNum("MIN_EMA_SLOPE", 0.03);
export const COOLDOWN_BARS   = envNum("COOLDOWN_BARS", 3);
export const MAX_POSITIONS   = envNum("MAX_POSITIONS", 1);

// ─── Exit Profile ─────────────────────────────────────────────
export const TP1_PCT            = envNum("TP1_FIXED_PCT", 0.08);
export const TP2_PCT            = envNum("TP2_FIXED_PCT", 0);
export const SL_PCT             = envNum("SL_MAX_PCT", 0.04);
export const TRAIL_PCT          = envNum("TRAIL_FIXED_PCT", 0);
export const MAX_BARS_IN_POS    = envNum("MAX_BARS_IN_POSITION", 12);

// ─── Sizing & Execution ──────────────────────────────────────
export const TRADE_PCT_USDC    = envNum("TRADE_PCT_USDC", 0.30);
export const MAX_SLIPPAGE_BPS  = envNum("MAX_SLIPPAGE_BPS", 75);
export const MIN_SOL_RESERVE   = envNum("MIN_SOL_RESERVE_LAMPORTS", 20_000_000); // 0.02 SOL for tx fees

// ─── Swap Arming (belt-and-suspenders) ────────────────────────
export const ENABLE_SWAPS          = envBool("ENABLE_SWAPS", false);
export const ALLOW_MAINNET_SWAPS   = envBool("ALLOW_MAINNET_SWAPS", false);
export const SOLANA_CLUSTER        = envStr("SOLANA_CLUSTER", "devnet");
export const SWAPS_ARMED = ENABLE_SWAPS && ALLOW_MAINNET_SWAPS && SOLANA_CLUSTER === "mainnet-beta";

// ─── Infrastructure ───────────────────────────────────────────
export const RPC_URL       = envStr("SOLANA_RPC_URL",
  SOLANA_CLUSTER === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com"
);
export const KEYPAIR_JSON  = envStr("AGENT_KEYPAIR_JSON", "");
export const ADMIN_TOKEN   = envStr("ADMIN_TOKEN", "");
export const PORT          = envNum("PORT", 8080);

// ─── Historical Data Sources ──────────────────────────────────
export const COINGECKO_ID  = envStr("COINGECKO_ID", "solana");

// ─── Jupiter API ──────────────────────────────────────────────
export const JUPITER_API_URL = envStr("JUPITER_API_URL", "https://api.jup.ag/swap/v1");
export const JUPITER_API_KEY = envStr("JUPITER_API_KEY", "");

// ─── Derived ──────────────────────────────────────────────────
export const BOT_NAME = `${TOKEN_SYMBOL} Surfer V6`;
export const WARMUP_BARS = Math.max(EMA_SLOW_LEN, ATR_LEN) + 5;

export function printConfig(): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${BOT_NAME} — Configuration`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Token:     ${TOKEN_SYMBOL} (${TOKEN_MINT.slice(0, 8)}...)`);
  console.log(`  Decimals:  ${TOKEN_DECIMALS}`);
  console.log(`  Bar size:  ${BAR_MS / 60_000}m`);
  console.log(`  EMA:       ${EMA_FAST_LEN}/${EMA_SLOW_LEN}  ATR: ${ATR_LEN}`);
  console.log(`  Zone:      ${ZONE_ATR_MULT} ATR`);
  console.log(`  Slope min: ${MIN_EMA_SLOPE}`);
  console.log(`  TP1:       ${(TP1_PCT * 100).toFixed(1)}%`);
  console.log(`  TP2:       ${TP2_PCT > 0 ? (TP2_PCT * 100).toFixed(1) + "%" : "disabled"}`);
  console.log(`  SL:        ${(SL_PCT * 100).toFixed(1)}%`);
  console.log(`  Trail:     ${TRAIL_PCT > 0 ? (TRAIL_PCT * 100).toFixed(1) + "%" : "disabled"}`);
  console.log(`  MaxBars:   ${MAX_BARS_IN_POS} (${MAX_BARS_IN_POS * BAR_MS / 3_600_000}h)`);
  console.log(`  Cooldown:  ${COOLDOWN_BARS} bars`);
  console.log(`  Size:      ${(TRADE_PCT_USDC * 100).toFixed(0)}% of USDC`);
  console.log(`  Slippage:  ${MAX_SLIPPAGE_BPS} bps`);
  console.log(`  Cluster:   ${SOLANA_CLUSTER}`);
  console.log(`  Jupiter:   ${JUPITER_API_URL}`);
  console.log(`  API Key:   ${JUPITER_API_KEY ? "✓ set" : "✗ NOT SET (will get 401)"}`);
  console.log();
  console.log(`  ╔══════════════════════════════════════╗`);
  console.log(`  ║  SWAP ARMING STATUS: ${SWAPS_ARMED ? "🟢 ARMED   " : "🔴 DISARMED"}  ║`);
  console.log(`  ║  ENABLE_SWAPS:       ${ENABLE_SWAPS ? "true " : "false"}            ║`);
  console.log(`  ║  ALLOW_MAINNET:      ${ALLOW_MAINNET_SWAPS ? "true " : "false"}            ║`);
  console.log(`  ║  CLUSTER:            ${SOLANA_CLUSTER.padEnd(18)}║`);
  console.log(`  ╚══════════════════════════════════════╝`);
  console.log(`${"=".repeat(60)}\n`);
}
