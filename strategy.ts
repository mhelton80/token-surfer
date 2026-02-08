/**
 * Token-Surfer V6 — Strategy Core
 * 
 * Clean mean-reversion dip-buying strategy:
 *   Entry:  Price dips below EMA(fast) by zone × ATR, while EMA slope > threshold
 *   Exit:   TP1 (fixed %), SL (fixed %), timeout (max bars), optional TP2/trail
 * 
 * No regime detection, no ML filter, no probe entries.
 * The EMA slope filter IS the regime filter — it keeps the bot out of downtrends.
 */

import {
  EMA_FAST_LEN, EMA_SLOW_LEN, ATR_LEN, ZONE_ATR_MULT,
  MIN_EMA_SLOPE, TP1_PCT, TP2_PCT, SL_PCT, TRAIL_PCT,
  MAX_BARS_IN_POS, COOLDOWN_BARS, MAX_POSITIONS,
  WARMUP_BARS, TOKEN_SYMBOL,
} from "./token-config.js";

// ─── Types ────────────────────────────────────────────────────

export interface Bar {
  t: number;  // unix timestamp (seconds)
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export interface Position {
  entryPrice: number;
  entryBar: number;      // index into bars array
  entryTime: number;     // unix timestamp
  highSinceEntry: number;
  tokenAmount: number;   // raw amount of token bought
  usdcSpent: number;     // USDC spent to buy
  txSignature?: string;  // buy tx signature
}

export type ExitReason = "tp1" | "tp2" | "trail" | "sl" | "timeout";

export interface ExitSignal {
  reason: ExitReason;
  pnlPct: number;
  barsHeld: number;
}

export interface EntrySignal {
  price: number;
  emaFast: number;
  emaSlow: number;
  atr: number;
  slope: number;
  zoneDepth: number;   // how far below zone top (in ATR units)
}

export interface Indicators {
  emaFast: number;
  emaSlow: number;
  atr: number;
  slope: number;       // (emaFast - emaSlow) / emaSlow
  buyZoneTop: number;  // emaFast - zone * ATR
  ready: boolean;      // enough bars for warmup
}

// ─── Indicator Computation ────────────────────────────────────

export class Strategy {
  bars: Bar[] = [];
  emaFastArr: number[] = [];
  emaSlowArr: number[] = [];
  atrArr: number[] = [];
  
  cooldownRemaining = 0;
  position: Position | null = null;
  
  // Cumulative stats
  totalTrades = 0;
  totalWins = 0;
  totalPnlPct = 0;
  peakEquity = 1;
  equity = 1;
  maxDrawdown = 0;
  
  /**
   * Add a new bar and recompute indicators.
   * Call this once per bar period.
   */
  addBar(bar: Bar): void {
    // Spike filter: reject bars with obviously corrupted OHLC
    if (this.bars.length > 0) {
      const prevClose = this.bars[this.bars.length - 1].c;
      const maxPrice = prevClose * 3;   // 3x previous close = clearly corrupted
      const minPrice = prevClose * 0.33;
      if (bar.h > maxPrice || bar.l < minPrice || bar.o > maxPrice || bar.c > maxPrice) {
        console.warn(
          `[SPIKE] Rejected bar ${new Date(bar.t * 1000).toISOString()}: ` +
          `O=${bar.o} H=${bar.h} L=${bar.l} C=${bar.c} (prev.c=${prevClose.toFixed(6)})`
        );
        // Clamp to sane values instead of dropping entirely (preserves bar count)
        bar = {
          t: bar.t,
          o: Math.min(Math.max(bar.o, minPrice), maxPrice),
          h: Math.min(Math.max(bar.h, minPrice), maxPrice),
          l: Math.min(Math.max(bar.l, minPrice), maxPrice),
          c: Math.min(Math.max(bar.c, minPrice), maxPrice),
        };
      }
    }
    
    this.bars.push(bar);
    const n = this.bars.length;
    
    // EMA fast
    if (n === 1) {
      this.emaFastArr.push(bar.c);
    } else {
      const k = 2 / (EMA_FAST_LEN + 1);
      this.emaFastArr.push(bar.c * k + this.emaFastArr[n - 2] * (1 - k));
    }
    
    // EMA slow
    if (n === 1) {
      this.emaSlowArr.push(bar.c);
    } else {
      const k = 2 / (EMA_SLOW_LEN + 1);
      this.emaSlowArr.push(bar.c * k + this.emaSlowArr[n - 2] * (1 - k));
    }
    
    // ATR
    if (n === 1) {
      this.atrArr.push(bar.h - bar.l);
    } else {
      const prev = this.bars[n - 2];
      const tr = Math.max(
        bar.h - bar.l,
        Math.abs(bar.h - prev.c),
        Math.abs(bar.l - prev.c),
      );
      if (n <= ATR_LEN) {
        // Simple average: recompute from raw bars (not from atrArr which holds averages)
        let trSum = this.bars[0].h - this.bars[0].l;
        for (let i = 1; i < n; i++) {
          trSum += Math.max(
            this.bars[i].h - this.bars[i].l,
            Math.abs(this.bars[i].h - this.bars[i - 1].c),
            Math.abs(this.bars[i].l - this.bars[i - 1].c),
          );
        }
        this.atrArr.push(trSum / n);
      } else {
        // Wilder's smoothing
        const prevAtr = this.atrArr[n - 2];
        this.atrArr.push((prevAtr * (ATR_LEN - 1) + tr) / ATR_LEN);
      }
    }
    
    // Tick cooldown
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining--;
    }
  }
  
  /**
   * Get current indicator values.
   */
  getIndicators(): Indicators {
    const n = this.bars.length;
    if (n === 0) {
      return { emaFast: 0, emaSlow: 0, atr: 0, slope: 0, buyZoneTop: 0, ready: false };
    }
    
    const emaFast = this.emaFastArr[n - 1];
    const emaSlow = this.emaSlowArr[n - 1];
    const atr     = this.atrArr[n - 1];
    const slope   = emaSlow > 0 ? (emaFast - emaSlow) / emaSlow : 0;
    const buyZoneTop = emaFast - atr * ZONE_ATR_MULT;
    
    return {
      emaFast, emaSlow, atr, slope, buyZoneTop,
      ready: n >= WARMUP_BARS,
    };
  }
  
  /**
   * Check if we should enter a position.
   * Returns EntrySignal if yes, null if no.
   */
  checkEntry(currentPrice: number): EntrySignal | null {
    const ind = this.getIndicators();
    if (!ind.ready) return null;
    if (this.position !== null) return null;
    if (this.cooldownRemaining > 0) return null;
    
    // Slope gate: must be in uptrend
    if (ind.slope < MIN_EMA_SLOPE) return null;
    
    // Zone gate: price must be below buy zone
    if (currentPrice > ind.buyZoneTop) return null;
    
    // ATR sanity check
    if (ind.atr <= 0) return null;
    
    const zoneDepth = (ind.buyZoneTop - currentPrice) / ind.atr;
    
    return {
      price: currentPrice,
      emaFast: ind.emaFast,
      emaSlow: ind.emaSlow,
      atr: ind.atr,
      slope: ind.slope,
      zoneDepth,
    };
  }
  
  /**
   * Open a position after entry signal confirmed.
   */
  openPosition(entryPrice: number, tokenAmount: number, usdcSpent: number, txSig?: string): void {
    const n = this.bars.length;
    this.position = {
      entryPrice,
      entryBar: n - 1,
      entryTime: this.bars[n - 1]?.t ?? Math.floor(Date.now() / 1000),
      highSinceEntry: entryPrice,
      tokenAmount,
      usdcSpent,
      txSignature: txSig,
    };
    console.log(`[ENTRY] ${TOKEN_SYMBOL} @ $${entryPrice.toFixed(4)} | ${tokenAmount.toFixed(2)} tokens | $${usdcSpent.toFixed(2)} USDC`);
  }
  
  /**
   * Check if we should exit the current position.
   * Returns ExitSignal if yes, null if no.
   */
  checkExit(currentPrice: number): ExitSignal | null {
    if (!this.position) return null;
    
    const pos = this.position;
    const barsHeld = this.bars.length - 1 - pos.entryBar;
    const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
    
    // Update high watermark
    if (currentPrice > pos.highSinceEntry) {
      pos.highSinceEntry = currentPrice;
    }
    
    // TP2 check (if enabled)
    if (TP2_PCT > 0 && pnlPct >= TP2_PCT) {
      return { reason: "tp2", pnlPct, barsHeld };
    }
    
    // TP1 check
    if (pnlPct >= TP1_PCT) {
      // If trailing stop enabled, wait for trail trigger
      if (TRAIL_PCT > 0) {
        const drawdownFromHigh = (pos.highSinceEntry - currentPrice) / pos.highSinceEntry;
        if (drawdownFromHigh >= TRAIL_PCT) {
          return { reason: "trail", pnlPct, barsHeld };
        }
        // TP1 reached but trail not triggered — hold
        return null;
      }
      return { reason: "tp1", pnlPct, barsHeld };
    }
    
    // Stop loss
    if (pnlPct <= -SL_PCT) {
      return { reason: "sl", pnlPct, barsHeld };
    }
    
    // Timeout
    if (barsHeld >= MAX_BARS_IN_POS) {
      return { reason: "timeout", pnlPct, barsHeld };
    }
    
    return null;
  }
  
  /**
   * Close the position and record stats.
   */
  closePosition(exitPrice: number, reason: ExitReason): { pnlPct: number; pnlNet: number } {
    if (!this.position) throw new Error("No position to close");
    
    const pos = this.position;
    const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
    const feePct = 0.0004; // ~4 bps round-trip via Jupiter Metis
    const pnlNet = pnlPct - feePct;
    const barsHeld = this.bars.length - 1 - pos.entryBar;
    
    // Update equity tracking
    this.equity *= (1 + pnlNet);
    if (this.equity > this.peakEquity) this.peakEquity = this.equity;
    const dd = (this.peakEquity - this.equity) / this.peakEquity;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    
    this.totalTrades++;
    if (pnlNet > 0) this.totalWins++;
    this.totalPnlPct += pnlNet;
    
    console.log(
      `[EXIT] ${TOKEN_SYMBOL} @ $${exitPrice.toFixed(4)} | reason=${reason} | ` +
      `pnl=${(pnlPct * 100).toFixed(2)}% net=${(pnlNet * 100).toFixed(2)}% | ` +
      `held=${barsHeld} bars | equity=${this.equity.toFixed(4)} | ` +
      `${this.totalTrades} trades, ${this.totalWins}W/${this.totalTrades - this.totalWins}L`
    );
    
    this.position = null;
    this.cooldownRemaining = COOLDOWN_BARS;
    
    return { pnlPct, pnlNet };
  }
  
  /**
   * Get strategy state for health endpoint / persistence.
   */
  getState(): Record<string, any> {
    const ind = this.getIndicators();
    return {
      token: TOKEN_SYMBOL,
      barsLoaded: this.bars.length,
      warmupComplete: ind.ready,
      indicators: ind.ready ? {
        emaFast: ind.emaFast.toFixed(4),
        emaSlow: ind.emaSlow.toFixed(4),
        atr: ind.atr.toFixed(4),
        atrPct: ((ind.atr / (ind.emaFast || 1)) * 100).toFixed(2) + "%",
        slope: ind.slope.toFixed(4),
        slopeAboveThreshold: ind.slope >= MIN_EMA_SLOPE,
        buyZoneTop: ind.buyZoneTop.toFixed(4),
      } : null,
      position: this.position ? {
        entryPrice: this.position.entryPrice,
        entryTime: new Date(this.position.entryTime * 1000).toISOString(),
        barsHeld: this.bars.length - 1 - this.position.entryBar,
        highSinceEntry: this.position.highSinceEntry,
        currentPnl: this.bars.length > 0
          ? (((this.bars[this.bars.length - 1].c - this.position.entryPrice) / this.position.entryPrice) * 100).toFixed(2) + "%"
          : "n/a",
      } : null,
      cooldownRemaining: this.cooldownRemaining,
      stats: {
        totalTrades: this.totalTrades,
        wins: this.totalWins,
        winRate: this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) + "%" : "n/a",
        totalPnlPct: (this.totalPnlPct * 100).toFixed(2) + "%",
        equity: this.equity.toFixed(4),
        maxDrawdown: (this.maxDrawdown * 100).toFixed(2) + "%",
      },
    };
  }
}
