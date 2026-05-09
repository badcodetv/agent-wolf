# Risk Management and Paper-Trading Harness for agent-wolf

## 1. Backtesting Frameworks

For an LLM-driven agent making slow, multi-day decisions, raw vectorized speed matters less than **fidelity to live execution path**. Pick a framework whose simulator can be swapped for a real broker behind the same interface.

- **vectorbt / vectorbt-pro** — Fastest for parameter sweeps and signal screening. Good for offline indicator research, weak for stateful agent loops. Use for *signal mining*, not for running the agent itself.
- **backtrader** — Mature, event-driven, single-threaded. Perfect mental model (Strategy.next()), but unmaintained since ~2023 and lacks native crypto/perps. Skip.
- **NautilusTrader** — Best fit. Rust core, Python API, async, native venue adapters including Binance perps and a growing Hyperliquid integration. Same `Strategy` runs in backtest, paper, and live. This is the "swap the simulator" property you want.
- **Lean / QuantConnect** — Cloud-coupled and C#-first. Extractable as the open-source Lean engine, but heavyweight and not crypto-native enough.
- **Hummingbot / Freqtrade** — Worth knowing. Freqtrade has a clean dry-run mode and good crypto adapters; its `dry_run: true` toggle is exactly the shadow-mode pattern. Hummingbot has Hyperliquid connectors.
- **Custom thin harness** — For an LLM agent, often the right call. The agent is the strategy; you mostly need (a) a clock, (b) a data feed, (c) an order router with a `simulate=True` flag, (d) a portfolio ledger. ~500 lines of Python.

**Historical data sources:**
- **Hyperliquid** publishes L2 book snapshots and trades to S3 (`hyperliquid-archive`); free, dense, multi-year by 2026.
- **Tardis.dev** — Gold standard for tick/L2 across CEXs and increasingly DEX perps. Paid but worth it for slippage modeling.
- **CCXT** — OHLCV across most CEXs; thin for DEXs.
- **Kaiko / Amberdata** — Institutional, expensive, skip for now.
- **Raw RPC + The Graph / Goldsky** for Solana DEX swap history (Jupiter aggregator events, Raydium pools).
- **Dune / Flipside** — Easy SQL access to Solana swap data, good for backfills.

**Recommendation:** NautilusTrader for the execution path, Tardis + Hyperliquid S3 for data, vectorbt for offline signal exploration.

## 2. Paper-Trading Patterns

Three distinct modes — agent-wolf needs all three:

1. **Shadow execution (live data, no orders)** — Agent runs against real-time feeds, emits intended orders to a logger and a simulated ledger. This is what "shadow mode from day one" means. Cheapest, most realistic for *signal* validation, but doesn't validate *fills*.
2. **Replay mode (historical data, simulated clock)** — For regression testing prompt changes. Critical: the agent must not "see" future bars. Use a clock abstraction that gates the LLM context to `t <= now`.
3. **Live paper (testnet or simulated portfolio against live book)** — **Hyperliquid has a usable testnet** with full perps API; an agent can hit it identically to mainnet. **Solana devnet is much weaker** for DEX flow — Jupiter/Raydium liquidity isn't there. For Solana, do live paper against mainnet quotes but never sign a transaction.

**Slippage / fill modeling for honest paper PnL:**
- Always fill at the *opposite* side of the book (taker), never midprice.
- For market orders, walk the L2 book by your size; use Tardis or HL snapshots.
- Add fixed fees (HL: 0.035% taker; Jupiter: ~0.1% + priority fee + MEV).
- For Solana, model **MEV/sandwich loss** explicitly — assume 20-50bps haircut on memecoin entries above a size threshold.
- Funding rates on perps must accrue every hour in the ledger.
- Add a **fill-rate dropout**: 5-10% of limit orders never fill — agents over-rely on perfect fills in backtests.

## 3. Risk Controls Every Autonomous Agent Needs

Implement these as a **separate process or middleware layer the agent cannot bypass** — not as prompt instructions. The LLM will rationalize its way around prompt rules.

**Hard limits (enforced in code, agent gets NACK):**
- Per-trade max loss: stop-loss attached at order submission, never optional.
- Per-day max drawdown: e.g. -3% portfolio → halt all new entries until UTC midnight.
- Total drawdown circuit breaker: -15% peak-to-trough → freeze, page operator.
- Position size cap: % of NAV per asset, per hypothesis cluster, per venue.
- Concentration cap: max N concurrent positions; max correlation cluster exposure.
- Leverage cap: per-position and aggregate (HL allows up to 50x — set agent ceiling at 3-5x).
- Per-hour notional throughput cap: prevents runaway loops.

**Sanity checks (reject the order):**
- Reject if price moved >X% in last Y minutes (stale-context guard).
- Reject if spread > Z bps (illiquidity guard).
- Reject if order size > K% of recent volume.
- Reject if oracle/market price diverges from index by >threshold.
- Reject if same (asset, side, hypothesis_id) traded in last cooldown window — **replay protection** keyed on a deterministic hash.

**Operational controls:**
- Kill switch as **file flag** (`/var/wolf/HALT`) checked every loop tick — simplest, can't fail.
- Webhook + signed Telegram/Discord command for remote pause.
- Heartbeat: if loop hasn't ticked in N minutes, external watchdog flattens positions.
- Idempotency keys on every order so retries don't double-fill.

These belong in a `RiskEngine` class that wraps the broker. Agent calls `risk.submit(order)`; risk engine validates, logs, and either forwards to broker or returns rejection with reason. **The simulator and live broker share this exact wrapper.**

## 4. Evaluation Metrics

Standard quant metrics:
- **Sharpe** (annualized, risk-free=0 for crypto) — known to flatter trend strategies, use as one of many.
- **Sortino** — better for asymmetric agent returns.
- **Calmar** = CAGR / |MaxDD| — most honest for agents prone to blow-ups.
- **Omega ratio** — captures full distribution.
- **Max drawdown, time-to-recovery, Ulcer index** — pain metrics; the user feels these, not Sharpe.
- **Win rate × avg win / avg loss** — expectancy decomposition.

Agent-specific (the more interesting set):
- **Hypothesis hit rate**: per-hypothesis PnL attribution. Tag every order with `hypothesis_id`.
- **Alpha decay**: PnL by holding-period bucket; flag when edge concentrates in first hour (likely overfit to entry).
- **Prompt-cost-per-dollar-PnL**: token spend / |gross PnL|. With Claude Max subscription this is rate-limited rather than $-metered, but track wallclock and request count as proxies.
- **Decision agreement**: same context replayed to the agent — does it produce the same action? Measure stochasticity.
- **Counterfactual regret**: log rejected risk-engine trades and shadow-fill them. If rejections would have made money, your risk engine is too tight.
- **Information ratio vs naive baselines**: equal-weight, BTC-only, momentum-only.

Publish a daily HTML report with these — the user will want to read it.

## 5. How Long Should Paper Run Before Live?

**Calendar time is the wrong unit. Trade count is.** A 30-day paper run with 8 trades proves nothing.

Reasonable bars:
- **Statistical**: minimum ~100 trades to estimate Sharpe with usable confidence intervals (SE of Sharpe ~ √(1/N)). For multi-day positions targeting 2-5 trades/week, that's 6-12 months of paper. Accept this.
- **Industry rule**: prop shops typically want 60-90 days of paper *plus* a trade-count threshold *plus* survival across one regime change.
- **Walk-forward validation**: split history into rolling train/validate windows. The agent should be re-evaluated weekly on the most recent unseen window, never on data its prompt has been tuned against.
- **Regime check**: paper must include at least one drawdown event and one volatility spike. If 2026 is calm, *extend* paper rather than going live early.

Pragmatic ramp for agent-wolf:
1. **Phase 0 (now)**: replay-mode against 2024-2025 history. Fix bugs.
2. **Phase 1**: shadow on live data, $0 capital, 60 days minimum AND ≥50 trades.
3. **Phase 2**: testnet (Hyperliquid) — same code path, real signing, real latency. 30 days.
4. **Phase 3**: $200-500 mainnet, hard caps everywhere. Continue shadow in parallel and reconcile fills.
5. **Phase 4**: scale only on out-of-sample Sharpe > 1.0 over ≥100 trades.

## 6. Concrete Recommendations for agent-wolf Shadow Mode

**Architecture — the boundary:**

```
Agent (LLM loop)
      |
      v
ExecutionGateway  <-- single interface: submit_order(), get_positions(), get_balance()
      |
   RiskEngine     <-- shared, identical in paper and live
      |
   +--+--+
   |     |
PaperBroker  LiveBroker(Hyperliquid / Jupiter)
```

The agent imports only `ExecutionGateway`. Mode is selected by config (`WOLF_MODE=shadow|testnet|live`). The agent code is byte-identical across modes — this is non-negotiable for the paper-vs-live comparison to be valid.

**What to log (everything, in append-only JSONL):**
- Full prompt text and full LLM response per decision (gzip after rotation).
- Tool calls and their results.
- Market snapshot at decision time (top-of-book, recent trades, funding).
- Hypothesis ID, parent hypothesis chain, confidence.
- Order intent → risk-engine verdict → simulated fill / live fill.
- Token usage and wallclock per loop tick.
- Every kill-switch check result.

Storage: SQLite for structured queries + Parquet for analytics + raw JSONL for forensics. Plan for ~50-200MB/day; cheap.

**Per-hypothesis isolated paper accounts:**

Treat each active hypothesis as its own sub-portfolio with its own NAV, its own risk budget, and its own ledger. This makes attribution clean and lets you kill bad hypotheses without touching others. Implement as a `SubAccount(hypothesis_id, allocated_nav)` with the RiskEngine enforcing per-subaccount limits. Aggregate to portfolio level for global circuit breakers.

**Reconciliation harness:** Once on testnet/live, run shadow in parallel and diff fills. Persistent divergence > 20bps means your slippage model is wrong — fix before scaling.

**Libraries to lean on:** `nautilus_trader`, `ccxt`, `hyperliquid-python-sdk`, `solders`/`solana-py`, `vectorbt` (research), `pyfolio-reloaded` or `quantstats` (metrics), `pandera` (data contracts), `pydantic` for order schemas, `hypothesis` for property-testing the risk engine.
