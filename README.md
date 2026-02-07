# Token-Surfer V6

Token-agnostic mean-reversion dip-buying bot for Solana SPL tokens. One codebase, multiple deployments — configure via environment variables.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│               token-surfer (one repo)               │
│                                                     │
│  token-config.ts  ← reads all params from env vars  │
│  strategy.ts      ← V6 EMA slope + ATR zone engine  │
│  jupiter.ts       ← Jupiter DEX quotes & swaps      │
│  state-manager.ts ← persistence to /data volume     │
│  runtime.ts       ← main loop + HTTP server         │
└──────────┬──────────────────────┬───────────────────┘
           │                      │
    fly.ray.toml              fly.jup.toml
           │                      │
  ┌────────▼────────┐   ┌────────▼────────┐
  │   ray-surfer    │   │   jup-surfer    │
  │   Fly.io app    │   │   Fly.io app    │
  │   Wallet B      │   │   Wallet C      │
  │   ray_data vol  │   │   jup_data vol  │
  │   TP1=10% SL=6% │   │   TP1=8% SL=4%  │
  │   Zone=0.5 ATR  │   │   Zone=0.7 ATR  │
  │   Slope≥0.04    │   │   Slope≥0.03    │
  │   MaxBars=8     │   │   MaxBars=12    │
  └─────────────────┘   └─────────────────┘
```

## Strategy (V6)

Simple, selective mean-reversion:

1. **Slope gate**: EMA(14)/EMA(50) slope must exceed threshold → only trade uptrends
2. **Zone entry**: Price must dip below EMA(14) − zone × ATR(14) → buy the dip
3. **Fixed exits**: TP1 (take profit), SL (stop loss), or timeout (max bars held)

No regime detection, no ML filter, no probe entries. The slope filter IS the regime filter.

### Why it works on high-vol tokens

| Token | TP1 | RT Fee | Fee Ratio | Signal Rate |
|-------|-----|--------|-----------|-------------|
| SOL   | 1%  | 0.16%  | 6×        | ~2%         |
| RAY   | 10% | 0.16%  | 63×       | 0.23%       |
| JUP   | 8%  | 0.16%  | 50×       | 0.24%       |

Wide profit targets make fees irrelevant. Extreme selectivity (~40 trades/year) avoids overtrading.

### Backtest Results (2yr, 16bps RT fees)

| Metric         | RAY        | JUP         |
|----------------|------------|-------------|
| Return         | +153.4%    | **+266.8%** |
| Sharpe         | 4.33       | **5.69**    |
| Max Drawdown   | 11.8%      | **7.1%**    |
| Win Rate       | 61.9%      | **70.7%**   |
| Profit Factor  | 3.88       | **5.56**    |
| Trades         | 42         | 41          |
| Buy & Hold     | −50.7%     | −63.7%      |

## Files

```
token-config.ts    Config from env vars (token, strategy, execution)
strategy.ts        V6 engine: indicators, entry/exit signals, position tracking
jupiter.ts         Jupiter API: price quotes, buy/sell quotes, swap execution
state-manager.ts   Persistence: bars, position, trades to /data volume
runtime.ts         Main loop: poll → build bars → check signals → execute → HTTP

fly.ray.toml       Fly.io config for RAY Surfer (strategy params baked in)
fly.jup.toml       Fly.io config for JUP Surfer (strategy params baked in)
Dockerfile         Build & runtime container
.env.example       Template showing all available settings
```

## Quick Start (Local)

```bash
# Install
npm install

# Create env file with your secrets
cp .env.example .env
# Edit .env: set SOLANA_RPC_URL, AGENT_KEYPAIR_JSON

# Build and run (shadow mode by default)
npm run dev

# Health check
curl http://localhost:8080/health | jq .
```

## Deployment

### Prerequisites

1. **Two fresh Solana wallets** (one for RAY, one for JUP)
   - Fund each with 0.05 SOL + $100 USDC
   - Export as JSON byte array
   - **Never reuse** your main wallet or each other's wallet

2. **RPC endpoint** (Helius, QuickNode, or Triton)

3. **Fly.io account** with `flyctl` installed

### Deploy RAY Surfer

```bash
# Create app and volume
fly apps create ray-surfer
fly volumes create ray_data --region iad --size 1 --app ray-surfer

# Set secrets (NEVER in fly.toml)
fly secrets set SOLANA_RPC_URL='https://your-rpc.com' --app ray-surfer
fly secrets set AGENT_KEYPAIR_JSON='[1,2,3,...]' --app ray-surfer
fly secrets set ADMIN_TOKEN='your_random_token' --app ray-surfer

# Deploy
fly deploy --config fly.ray.toml

# Verify
fly logs --app ray-surfer
curl https://ray-surfer.fly.dev/health | jq .
```

### Deploy JUP Surfer

```bash
# Create app and volume
fly apps create jup-surfer
fly volumes create jup_data --region iad --size 1 --app jup-surfer

# Set secrets
fly secrets set SOLANA_RPC_URL='https://your-rpc.com' --app jup-surfer
fly secrets set AGENT_KEYPAIR_JSON='[4,5,6,...]' --app jup-surfer
fly secrets set ADMIN_TOKEN='your_random_token' --app jup-surfer

# Deploy
fly deploy --config fly.jup.toml

# Verify
fly logs --app jup-surfer
curl https://jup-surfer.fly.dev/health | jq .
```

## 3-Step Go-Live Runbook

### Step 1 — Shadow Mode (1-2 days)

Both bots deploy with swaps disabled by default. Monitor:

```bash
# Watch for signal generation
curl https://ray-surfer.fly.dev/health | jq '.lastSignal, .barsLoaded, .warmupComplete'
curl https://jup-surfer.fly.dev/health | jq '.lastSignal, .barsLoaded, .warmupComplete'
```

**Checklist:**
- [ ] Warmup completes (55+ bars)
- [ ] Slope filter correctly gates entries
- [ ] Price polling stable (priceErrors low)
- [ ] No memory leaks in logs
- [ ] Shadow trades appearing in /trades endpoint

### Step 2 — Arm Swaps

```bash
# RAY
fly secrets set ENABLE_SWAPS=true ALLOW_MAINNET_SWAPS=true --app ray-surfer
fly deploy --config fly.ray.toml

# JUP
fly secrets set ENABLE_SWAPS=true ALLOW_MAINNET_SWAPS=true --app jup-surfer
fly deploy --config fly.jup.toml
```

### Step 3 — Monitor First Month

```bash
# Daily check
curl https://ray-surfer.fly.dev/metrics | jq .
curl https://jup-surfer.fly.dev/metrics | jq .

# Trade history
curl https://ray-surfer.fly.dev/trades | jq .
curl https://jup-surfer.fly.dev/trades | jq .
```

**Expected activity:** ~1-2 trades/month per bot. Long idle periods are normal — the slope filter keeps the bot out of downtrends.

## HTTP Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | none | Full state: indicators, position, stats |
| `/metrics` | GET | none | Compact: price, signal, stats |
| `/trades` | GET | none | Complete trade history |
| `/admin/save` | POST | ADMIN_TOKEN | Force state persist |
| `/admin/close` | POST | ADMIN_TOKEN | Emergency close position |

## Swap Arming (Belt-and-Suspenders)

Real swaps ONLY execute when ALL THREE conditions are true:

| Variable | Required Value |
|----------|---------------|
| `ENABLE_SWAPS` | `true` |
| `ALLOW_MAINNET_SWAPS` | `true` |
| `SOLANA_CLUSTER` | `mainnet-beta` |

Startup log prints a clear **SWAP ARMING STATUS** banner.

## Adding New Tokens

To deploy for any new Solana SPL token:

1. Run backtest to find optimal parameters
2. Create `fly.{token}.toml` with the token's mint, decimals, and optimal strategy params
3. Create a new wallet and fund it
4. `fly apps create {token}-surfer && fly volumes create {token}_data ...`
5. Set secrets and deploy

The codebase doesn't change — only the config does.
