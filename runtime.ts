/**
 * Token-Surfer V6 — Runtime
 * 
 * Main event loop:
 *   1. Poll price every SAMPLE_INTERVAL_MS
 *   2. Accumulate OHLC bars
 *   3. On each new bar: check entry/exit signals
 *   4. Execute swaps via Jupiter if armed
 *   5. Persist state after every trade
 *   6. Serve health/metrics via HTTP
 */

import * as http from "http";
import {
  Connection, Keypair, VersionedTransaction, PublicKey,
} from "@solana/web3.js";

import {
  TOKEN_SYMBOL, TOKEN_UNIT, USDC_UNIT, TOKEN_MINT, USDC_MINT,
  BAR_MS, SAMPLE_INTERVAL_MS, TRADE_PCT_USDC, MIN_SOL_RESERVE,
  PORT, RPC_URL, KEYPAIR_JSON, ADMIN_TOKEN, SWAPS_ARMED,
  COINGECKO_ID, BOT_NAME, printConfig, MIN_EMA_SLOPE,
} from "./token-config.js";

import {
  getTokenPrice, getBuyQuote, getSellQuote,
  getSwapTransaction, fetchCoinGeckoHistory,
} from "./jupiter.js";

import { Strategy, Bar, ExitReason } from "./strategy.js";
import {
  saveState, loadState, saveBars, loadBars,
  appendTrade, loadTrades, PersistedState,
} from "./state-manager.js";


// ─── Globals ──────────────────────────────────────────────────

let connection: Connection;
let wallet: Keypair;
const strategy = new Strategy();

// Current bar accumulation
let currentBarStart = 0;
let currentBarOpen = 0;
let currentBarHigh = -Infinity;
let currentBarLow = Infinity;
let currentBarClose = 0;
let lastPrice = 0;
let lastPriceTime = 0;

// Metrics
let loopCount = 0;
let priceErrors = 0;
let lastSignalCheck = "";
let startTime = Date.now();


// ─── Initialization ───────────────────────────────────────────

async function init(): Promise<void> {
  printConfig();

  connection = new Connection(RPC_URL, "confirmed");

  if (KEYPAIR_JSON) {
    try {
      const keyBytes = JSON.parse(KEYPAIR_JSON);
      wallet = Keypair.fromSecretKey(Uint8Array.from(keyBytes));
      console.log(`[INIT] Wallet: ${wallet.publicKey.toBase58()}`);
    } catch (err) {
      throw new Error(`Failed to parse AGENT_KEYPAIR_JSON: ${err}`);
    }
  } else if (SWAPS_ARMED) {
    throw new Error("AGENT_KEYPAIR_JSON is required when swaps are armed");
  } else {
    console.log(`[INIT] No wallet configured — running in shadow/monitor mode`);
  }

  // Load persisted state
  const savedBars = loadBars();
  const savedState = loadState();

  if (savedBars.length > 0) {
    console.log(`[INIT] Restoring ${savedBars.length} bars from disk`);
    for (const bar of savedBars) {
      strategy.addBar(bar);
    }
  }

  if (savedState) {
    console.log(`[INIT] Restoring state: ${savedState.totalTrades} trades, equity=${savedState.equity.toFixed(4)}`);
    strategy.position = savedState.position;
    strategy.cooldownRemaining = savedState.cooldownRemaining;
    strategy.totalTrades = savedState.totalTrades;
    strategy.totalWins = savedState.totalWins;
    strategy.totalPnlPct = savedState.totalPnlPct;
    strategy.equity = savedState.equity;
    strategy.peakEquity = savedState.peakEquity;
    strategy.maxDrawdown = savedState.maxDrawdown;
  }

  // CoinGecko backfill if we need more bars
  if (strategy.bars.length < 60) {
    console.log(`[INIT] Backfilling from CoinGecko (${COINGECKO_ID})...`);
    try {
      const history = await fetchCoinGeckoHistory(COINGECKO_ID, 14);
      if (history.length > 0) {
        const existingTimes = new Set(strategy.bars.map((b) => b.t));
        let added = 0;
        for (const bar of history) {
          if (!existingTimes.has(bar.t)) {
            strategy.addBar(bar);
            added++;
          }
        }
        console.log(`[INIT] CoinGecko: added ${added} bars (total: ${strategy.bars.length})`);
      }
    } catch (err) {
      console.warn(`[INIT] CoinGecko backfill failed: ${err}. Continuing with ${strategy.bars.length} bars.`);
    }
  }

  console.log(`[INIT] Ready. ${strategy.bars.length} bars loaded. Warmup: ${strategy.getIndicators().ready ? "✓" : "pending"}`);
}


// ─── Price Polling & Bar Building ─────────────────────────────

async function pollPrice(): Promise<number | null> {
  try {
    const price = await getTokenPrice();
    lastPrice = price;
    lastPriceTime = Date.now();
    return price;
  } catch (err) {
    priceErrors++;
    if (priceErrors % 10 === 1) {
      console.warn(`[PRICE] Error #${priceErrors}: ${err}`);
    }
    return null;
  }
}

function processPrice(price: number, now: number): boolean {
  const barStart = Math.floor(now / BAR_MS) * BAR_MS;

  if (barStart === currentBarStart) {
    if (price > currentBarHigh) currentBarHigh = price;
    if (price < currentBarLow) currentBarLow = price;
    currentBarClose = price;
    return false;
  }

  // New bar — close previous if it existed
  let newBar = false;
  if (currentBarStart > 0 && currentBarClose > 0) {
    const bar: Bar = {
      t: Math.floor(currentBarStart / 1000),
      o: currentBarOpen,
      h: currentBarHigh,
      l: currentBarLow,
      c: currentBarClose,
    };
    strategy.addBar(bar);
    newBar = true;

    if (strategy.bars.length % 10 === 0) {
      saveBars(strategy.bars);
    }
  }

  currentBarStart = barStart;
  currentBarOpen = price;
  currentBarHigh = price;
  currentBarLow = price;
  currentBarClose = price;

  return newBar;
}


// ─── Trade Execution ──────────────────────────────────────────

async function getUsdcBalance(): Promise<number> {
  try {
    const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(USDC_MINT),
    });
    if (resp.value.length === 0) return 0;
    return resp.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  } catch (err) {
    console.warn(`[BALANCE] USDC error: ${err}`);
    return 0;
  }
}

async function getTokenBalance(): Promise<number> {
  try {
    const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(TOKEN_MINT),
    });
    if (resp.value.length === 0) return 0;
    return resp.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  } catch (err) {
    console.warn(`[BALANCE] ${TOKEN_SYMBOL} error: ${err}`);
    return 0;
  }
}

async function executeBuy(price: number): Promise<boolean> {
  if (!SWAPS_ARMED) {
    console.log(`[SHADOW] Would BUY ${TOKEN_SYMBOL} @ $${price.toFixed(4)} — swaps disarmed`);
    const shadowUsdc = 100;
    const posSize = shadowUsdc * TRADE_PCT_USDC;
    const estTokens = posSize / price;
    strategy.openPosition(price, estTokens, posSize, "shadow");
    persistState();
    return true;
  }

  try {
    const usdcBalance = await getUsdcBalance();
    const positionSize = usdcBalance * TRADE_PCT_USDC;

    if (positionSize < 1) {
      console.warn(`[BUY] Insufficient USDC: $${usdcBalance.toFixed(2)}`);
      return false;
    }

    console.log(`[BUY] Getting quote: $${positionSize.toFixed(2)} USDC → ${TOKEN_SYMBOL}...`);
    const quote = await getBuyQuote(positionSize);

    if (quote.priceImpactPct > 1.0) {
      console.warn(`[BUY] Price impact too high: ${quote.priceImpactPct.toFixed(2)}%. Skipping.`);
      return false;
    }

    const swapTx = await getSwapTransaction(quote.raw, wallet.publicKey.toBase58());
    const txBuf = Buffer.from(swapTx, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    console.log(`[BUY] Tx sent: ${sig}`);

    const conf = await connection.confirmTransaction(sig, "confirmed");
    if (conf.value.err) {
      console.error(`[BUY] Tx failed: ${JSON.stringify(conf.value.err)}`);
      return false;
    }

    const tokensBought = Number(quote.outAmount) / TOKEN_UNIT;
    strategy.openPosition(quote.priceUsdcPerToken, tokensBought, positionSize, sig);
    persistState();
    console.log(`[BUY] ✓ ${tokensBought.toFixed(2)} ${TOKEN_SYMBOL} @ $${quote.priceUsdcPerToken.toFixed(4)} | ${sig}`);
    return true;
  } catch (err) {
    console.error(`[BUY] Failed: ${err}`);
    return false;
  }
}

async function executeSell(reason: ExitReason): Promise<boolean> {
  if (!strategy.position) return false;
  const pos = strategy.position;

  if (!SWAPS_ARMED || pos.txSignature === "shadow") {
    const exitPrice = lastPrice;
    const result = strategy.closePosition(exitPrice, reason);
    appendTrade({
      entryTime: new Date(pos.entryTime * 1000).toISOString(),
      exitTime: new Date().toISOString(),
      entryPrice: pos.entryPrice,
      exitPrice,
      reason,
      pnlPct: result.pnlPct,
      pnlNet: result.pnlNet,
      barsHeld: strategy.bars.length - 1 - pos.entryBar,
      equityAfter: strategy.equity,
    });
    persistState();
    return true;
  }

  try {
    const tokenBalance = await getTokenBalance();
    if (tokenBalance < 0.001) {
      console.warn(`[SELL] No ${TOKEN_SYMBOL} balance`);
      strategy.closePosition(lastPrice, reason);
      persistState();
      return false;
    }

    console.log(`[SELL] Getting quote: ${tokenBalance.toFixed(2)} ${TOKEN_SYMBOL} → USDC...`);
    const quote = await getSellQuote(tokenBalance);

    const swapTx = await getSwapTransaction(quote.raw, wallet.publicKey.toBase58());
    const txBuf = Buffer.from(swapTx, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    console.log(`[SELL] Tx sent: ${sig}`);

    const conf = await connection.confirmTransaction(sig, "confirmed");
    if (conf.value.err) {
      console.error(`[SELL] Tx failed: ${JSON.stringify(conf.value.err)}`);
      return false;
    }

    const exitPrice = quote.priceUsdcPerToken;
    const result = strategy.closePosition(exitPrice, reason);
    appendTrade({
      entryTime: new Date(pos.entryTime * 1000).toISOString(),
      exitTime: new Date().toISOString(),
      entryPrice: pos.entryPrice,
      exitPrice,
      reason,
      pnlPct: result.pnlPct,
      pnlNet: result.pnlNet,
      barsHeld: strategy.bars.length - 1 - pos.entryBar,
      equityAfter: strategy.equity,
    });
    persistState();
    console.log(`[SELL] ✓ @ $${exitPrice.toFixed(4)} | ${reason} | ${sig}`);
    return true;
  } catch (err) {
    console.error(`[SELL] Failed: ${err}`);
    return false;
  }
}


// ─── State Persistence ────────────────────────────────────────

function persistState(): void {
  saveState({
    position: strategy.position,
    cooldownRemaining: strategy.cooldownRemaining,
    totalTrades: strategy.totalTrades,
    totalWins: strategy.totalWins,
    totalPnlPct: strategy.totalPnlPct,
    equity: strategy.equity,
    peakEquity: strategy.peakEquity,
    maxDrawdown: strategy.maxDrawdown,
    lastSaveTime: new Date().toISOString(),
  });
  saveBars(strategy.bars);
}


// ─── Main Loop ────────────────────────────────────────────────

async function mainLoop(): Promise<void> {
  loopCount++;

  const price = await pollPrice();
  if (price === null) return;

  const now = Date.now();
  const isNewBar = processPrice(price, now);

  // Check exit on EVERY tick (not just new bars) for responsive SL/TP
  if (strategy.position) {
    const exitSignal = strategy.checkExit(price);
    if (exitSignal) {
      lastSignalCheck = `EXIT: ${exitSignal.reason} pnl=${(exitSignal.pnlPct * 100).toFixed(2)}%`;
      await executeSell(exitSignal.reason);
      return;
    }

    const pos = strategy.position;
    const curPnl = ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2);
    const held = strategy.bars.length - 1 - pos.entryBar;
    lastSignalCheck = `HOLD: pnl=${curPnl}% bars=${held}`;
  }

  // Check entry only on new bars (per strategy design)
  if (isNewBar && !strategy.position) {
    const ind = strategy.getIndicators();
    if (!ind.ready) {
      lastSignalCheck = `warmup (${strategy.bars.length} bars)`;
      return;
    }

    const entrySignal = strategy.checkEntry(price);
    if (entrySignal) {
      lastSignalCheck = `ENTRY: slope=${entrySignal.slope.toFixed(4)} depth=${entrySignal.zoneDepth.toFixed(2)}×ATR`;
      await executeBuy(price);
    } else {
      if (ind.slope < MIN_EMA_SLOPE) {
        lastSignalCheck = `IDLE: slope=${ind.slope.toFixed(4)} < ${MIN_EMA_SLOPE} (downtrend)`;
      } else if (price > ind.buyZoneTop) {
        lastSignalCheck = `WAIT: $${price.toFixed(4)} above zone $${ind.buyZoneTop.toFixed(4)}`;
      } else if (strategy.cooldownRemaining > 0) {
        lastSignalCheck = `COOL: ${strategy.cooldownRemaining} bars remaining`;
      }
    }
  }
}


// ─── HTTP Server ──────────────────────────────────────────────

function startHttpServer(): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    res.setHeader("Content-Type", "application/json");

    // ── Health ──
    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: "ok",
        bot: BOT_NAME,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        swapsArmed: SWAPS_ARMED,
        lastPrice: lastPrice > 0 ? lastPrice.toFixed(4) : null,
        lastPriceAge: lastPriceTime > 0 ? Math.floor((Date.now() - lastPriceTime) / 1000) + "s" : "never",
        lastSignal: lastSignalCheck,
        loopCount,
        priceErrors,
        ...strategy.getState(),
      }, null, 2));
      return;
    }

    // ── Trades history ──
    if (url.pathname === "/trades") {
      const trades = loadTrades();
      res.writeHead(200);
      res.end(JSON.stringify({ count: trades.length, trades }, null, 2));
      return;
    }

    // ── Metrics (compact) ──
    if (url.pathname === "/metrics") {
      const state = strategy.getState();
      res.writeHead(200);
      res.end(JSON.stringify({
        bot: BOT_NAME,
        price: lastPrice.toFixed(4),
        signal: lastSignalCheck,
        bars: strategy.bars.length,
        ...state.stats,
        position: state.position ? "open" : "none",
      }, null, 2));
      return;
    }

    // ── Admin: force save ──
    if (url.pathname === "/admin/save" && req.method === "POST") {
      const token = req.headers["x-admin-token"] ?? url.searchParams.get("token");
      if (ADMIN_TOKEN && token !== ADMIN_TOKEN) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      persistState();
      res.writeHead(200);
      res.end(JSON.stringify({ saved: true }));
      return;
    }

    // ── Admin: force close position ──
    if (url.pathname === "/admin/close" && req.method === "POST") {
      const token = req.headers["x-admin-token"] ?? url.searchParams.get("token");
      if (ADMIN_TOKEN && token !== ADMIN_TOKEN) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (!strategy.position) {
        res.writeHead(200);
        res.end(JSON.stringify({ message: "no position to close" }));
        return;
      }
      await executeSell("timeout");
      res.writeHead(200);
      res.end(JSON.stringify({ message: "position closed", ...strategy.getState() }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(PORT, () => {
    console.log(`[HTTP] Listening on :${PORT}`);
  });
}


// ─── Entry Point ──────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await init();
    startHttpServer();

    // Main loop
    console.log(`[LOOP] Starting (interval: ${SAMPLE_INTERVAL_MS / 1000}s)`);
    setInterval(async () => {
      try {
        await mainLoop();
      } catch (err) {
        console.error(`[LOOP] Unhandled error: ${err}`);
      }
    }, SAMPLE_INTERVAL_MS);

    // Periodic state save (every 5 minutes)
    setInterval(() => {
      persistState();
    }, 5 * 60 * 1000);

  } catch (err) {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  }
}

main();
