/**
 * Token-Surfer V6 — State Manager
 * 
 * Persists bars, position, and stats to disk so the bot can
 * survive restarts without losing context.
 */

import * as fs from "fs";
import * as path from "path";
import { Bar, Position } from "./strategy.js";
import { TOKEN_SYMBOL } from "./token-config.js";

const DATA_DIR  = process.env.DATA_DIR ?? "/data";
const STATE_FILE = path.join(DATA_DIR, `${TOKEN_SYMBOL.toLowerCase()}-state.json`);
const BARS_FILE  = path.join(DATA_DIR, `${TOKEN_SYMBOL.toLowerCase()}-bars.json`);
const TRADES_FILE = path.join(DATA_DIR, `${TOKEN_SYMBOL.toLowerCase()}-trades.json`);

export interface PersistedState {
  position: Position | null;
  cooldownRemaining: number;
  totalTrades: number;
  totalWins: number;
  totalPnlPct: number;
  equity: number;
  peakEquity: number;
  maxDrawdown: number;
  lastSaveTime: string;
}

export interface TradeRecord {
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  reason: string;
  pnlPct: number;
  pnlNet: number;
  barsHeld: number;
  equityAfter: number;
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Save strategy state atomically (write to temp, then rename).
 */
export function saveState(state: PersistedState): void {
  ensureDir();
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * Load strategy state from disk. Returns null if no state exists.
 */
export function loadState(): PersistedState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[STATE] Failed to load state: ${err}. Starting fresh.`);
    return null;
  }
}

/**
 * Save bars array to disk (for warm restart).
 * Only saves last N bars to keep file small.
 */
export function saveBars(bars: Bar[], maxBars: number = 500): void {
  ensureDir();
  const toSave = bars.slice(-maxBars);
  const tmp = BARS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(toSave));
  fs.renameSync(tmp, BARS_FILE);
}

/**
 * Load bars from disk.
 */
export function loadBars(): Bar[] {
  try {
    if (!fs.existsSync(BARS_FILE)) return [];
    const raw = fs.readFileSync(BARS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[STATE] Failed to load bars: ${err}. Starting fresh.`);
    return [];
  }
}

/**
 * Append a trade record to the trades log.
 */
export function appendTrade(trade: TradeRecord): void {
  ensureDir();
  let trades: TradeRecord[] = [];
  try {
    if (fs.existsSync(TRADES_FILE)) {
      trades = JSON.parse(fs.readFileSync(TRADES_FILE, "utf-8"));
    }
  } catch { /* start fresh */ }
  
  trades.push(trade);
  const tmp = TRADES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
  fs.renameSync(tmp, TRADES_FILE);
}

/**
 * Load all trade records.
 */
export function loadTrades(): TradeRecord[] {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];
    return JSON.parse(fs.readFileSync(TRADES_FILE, "utf-8"));
  } catch {
    return [];
  }
}
