# Technical & Quantitative Analysis for LLM Trading Agents

## 1. TA Libraries — what to actually use in 2026

| Library | Status (May 2026) | Verdict for agent-wolf |
|---|---|---|
| **TA-Lib** (C core) | Still actively maintained, fastest, gold-standard implementations. Install pain on Windows/ARM remains, but `pip install ta-lib-binary` wheels and conda-forge fix most of it. | Use it if you can install it; it's the reference. |
| **pandas-ta** | The original `twopirllc/pandas-ta` is "at risk of discontinuation" per its own maintainer. The community fork **`pandas-ta-classic`** (xgboosted) is the actively maintained successor — 252 indicators + candlestick patterns, optional numba JIT for 6–230x speedups, no TA-Lib dependency required. | **Recommended default.** Pure-Python, easy to install in any container. |
| **tulipy** | Mostly dormant; pandas-ta-classic now covers ~71 of its indicators. | Skip. |
| **`ta` (bukosabino/ta)** | Maintained, smaller surface, clean API. | Fine for simple scripts. |

**Crypto/DEX-aware:** No mature "all-in-one" lib exists. The pragmatic stack is:
- **CCXT** for spot CEX data normalization (still useful for reference prices).
- **Hyperliquid Python SDK** + **dYdX v4 client** for perps DEX order book / funding / OI.
- **`web3.py` / `viem`** for on-chain spot DEX (Uniswap v3/v4 pools, ticks).
- **Buildix / Coinglass / CryptoQuant APIs** for orderflow analytics (CVD, OI delta, liquidation maps) — DIY-ing these from raw trades is expensive.

## 2. Indicators with empirical edge — the honest list

The literature is brutal: most single indicators on a single timeframe do not survive transaction costs and multiple-testing correction. What *does* survive:

**High-confidence (peer-reviewed edge):**
- **Time-series momentum** — Moskowitz, Ooi & Pedersen (2012) showed the 12-month past return predicts the next 1–12 months across **58 futures contracts**, partially reversing thereafter ([JFE 2012](https://www.sciencedirect.com/science/article/pii/S0304405X11002613)). Replicated for crypto in multiple papers; this is the single most robust technical signal known.
- **Trend filters using long MAs (e.g. 200d, 50/200 cross)** — used as a regime *filter* rather than a trigger; they cut drawdowns sharply on BTC/ETH historically (AlphaArchitect, Robot Wealth).
- **ATR for risk normalization** — not a directional signal but essential for sizing (see §3).
- **Volatility-managed portfolios** — Moreira & Muir (JoF 2017) showed scaling exposure inversely to recent volatility raises Sharpe across factors ([paper](https://amoreira2.github.io/alan-moreira.github.io/VolPortfolios_published.pdf)).

**Useful but weaker / context-dependent:**
- **RSI / Stoch RSI / MACD / Bollinger** — most academic backtests show they fail to beat buy-and-hold on liquid instruments after costs (e.g. JIER 2024, multiple Bollinger/RSI replications). They *can* work as part of a multi-condition rule (regime + RSI + volume) but are easily data-mined.
- **VWAP** — robust as an *execution* benchmark, weak as a directional signal alone.
- **Keltner / Bollinger band breakouts** — work in trending regimes, get whipsawed in chop.

**Crypto-specific (perps DEX) — the real edge:**
- **Funding rate** — actionable when paired with OI. Rising OI + extreme positive funding = crowded longs, vulnerable to long-squeeze cascades. Standalone predictive power is *limited*; cross-sectional (rank assets by funding z-score) is stronger ([Amberdata, MetaMask](https://blog.amberdata.io/funding-rates-how-they-impact-perpetual-swap-positions)).
- **Basis (perp vs spot)** — pure carry trade signal; positive basis lets you long spot / short perp for funding harvest.
- **Open Interest delta** — rising OI confirms a trend; falling OI on a price move = short covering / long unwind, often fades.
- **Liquidation cascades / heatmaps** — Coinglass/Hyperblitz "liq maps" show clustered stops; price tends to magnet toward thick liquidation pools.
- **CVD (Cumulative Volume Delta)** — divergence (price up, CVD flat) is a high-quality fade signal on perps. Spot-vs-perp CVD divergence is the strongest variant.

## 3. Position sizing & money management

- **Full Kelly is suicide in crypto.** The formula assumes precise edge estimates; crypto's fat tails make those estimates wildly noisy. Empirical sims: betting 30% of Kelly cuts the chance of a 80% drawdown from 1-in-5 to 1-in-213 while retaining ~51% of the growth ([Matthew Downey's sim](https://matthewdowney.github.io/uncertainty-kelly-criterion-optimal-bet-size.html)). **Quarter-Kelly (0.25) is the consensus default.**
- **Volatility targeting** — size each position so its expected daily $-vol equals a fixed target (e.g. 50 bps of equity). Position size = (target_vol × equity) / (ATR × price). This is more important than the entry signal.
- **Risk parity across hypotheses** — when running N concurrent LLM hypotheses, weight each so its volatility contribution is equal; otherwise the loudest hypothesis dominates the book.
- **Anti-Martingale for hypothesis budgets** — give each hypothesis a fixed initial budget; *increase* allocation only as the hypothesis posts realized PnL (compound winners), and cut to zero on drawdown breach. Never average down on a losing hypothesis. This is the Turtle/Dennis rule and survives every regime.

## 4. Regime detection

- **HMMs on returns + realized vol** are the academic standard. A 3-state model (calm-up / chop / crash) outperforms 2-state on BTC; 4-state NHHM has the best one-step-ahead forecast ([MDPI 2025](https://www.mdpi.com/2227-7390/13/10/1577)).
- **Cheap, robust alternative:** ATR percentile + 200d MA slope. If 30d realized vol > 90th percentile → "crash regime," disable mean-reversion strategies. If price > 200d MA and slope > 0 → "trending up," enable momentum.
- **Crypto-specific regime signals:**
  - **BTC dominance trending up** → alts bleed; trim alt exposure.
  - **Funding rate regime** — sustained positive funding across majors = late-cycle bull; sustained negative = capitulation (often the best long entries).
  - **Stablecoin supply growth** — leading indicator of inflows.

Use a regime layer as a **gate**, not a signal — it decides which strategies are *enabled* this week, not what to trade.

## 5. The crucial question — LLM vs deterministic code division

Empirical evidence from FinMem, FINCON, and TradingAgents converges on one answer: **LLMs are good at synthesis and hypothesis generation, bad at arithmetic and execution.**

- **FinMem** ([arxiv 2311.13743](https://arxiv.org/abs/2311.13743)) — LLM agent with layered memory + character profile *generates* the trade; the loop converts memory insights to discrete buy/sell. Edge came from memory architecture, not from letting the LLM compute sizes.
- **TradingAgents** ([arxiv 2412.20138](https://arxiv.org/abs/2412.20138)) — explicitly uses *structured output* (`llm.with_structured_output(Schema)`) and a deterministic `SignalProcessor` heuristic to translate the LLM's markdown rating into a position. Risk management agent enforces predefined limits — code, not LLM, holds the kill switch.
- **FINCON** (NeurIPS 2024) — multi-agent with verbal-reinforcement risk control; final position sizes computed deterministically.

**Recommended pattern for agent-wolf — Pattern A+B hybrid:**

| Layer | Owner | Why |
|---|---|---|
| Signal/feature computation | **Code** | Deterministic, auditable, no hallucination. |
| Regime classification | **Code** (HMM or rules) | Numeric; LLMs are bad at this. |
| Hypothesis generation (news, narrative, cross-asset) | **LLM** | Synthesis is the killer app. |
| Trade proposal (asset, direction, thesis, invalidation) | **LLM** with structured output | Forces it to commit to falsifiable claims. |
| **Validation gate** (does proposal match risk rules, regime, exposure limits?) | **Code** | Hard rules. Reject if violated. |
| Position sizing | **Code** (vol-target × 0.25 Kelly cap) | Math, not narrative. |
| Order execution & slippage control | **Code** | Speed + precision. |
| Post-trade review / hypothesis scoring | **LLM-as-judge** (Pattern D) | Good at narrative attribution; feeds back into memory. |

**Avoid Pattern C** (LLM is the final-call trader with no code gate) — every paper that tried it got burned by hallucinated numbers, wrong asset tickers, and sizing errors.

## 6. Recommended stack for agent-wolf MVP

**Indicators (5):**
1. **200-day MA + slope** — regime gate.
2. **ATR(14)** — vol-target sizing input.
3. **12-month time-series momentum z-score** — primary directional signal (Moskowitz/Pedersen).
4. **Perps funding rate z-score (cross-sectional)** — crowding fade signal.
5. **Spot-vs-perp CVD divergence** — entry timing / exhaustion.

**Position sizing rule:**
- Per-trade size = `min(vol_target / (ATR × price), 0.25 × kelly_estimate, 5% equity cap)`.
- Per-hypothesis budget = 10–20% of capital, anti-Martingale (compound on realized PnL, hard-stop at -25% of allocated budget).
- Portfolio vol target ~30–40% annualized for experimental crypto book.

**Division of labor:**
- LLM agents: research synthesis (news/Twitter/Discord/on-chain), hypothesis JSON {asset, direction, thesis, invalidation_price, horizon_days, confidence}, post-trade journaling.
- Deterministic code: indicator computation (pandas-ta-classic), regime classifier, validation gate, Kelly+vol sizer, order router, risk killswitch (hard equity drawdown circuit breaker).

**Stack:** Python + pandas-ta-classic + CCXT + Hyperliquid SDK + DuckDB for tick storage + a thin agent orchestrator (the Claude Code CLI itself, given the token model).

---

## Sources
- [Moskowitz, Ooi, Pedersen — Time Series Momentum (JFE 2012)](https://www.sciencedirect.com/science/article/pii/S0304405X11002613)
- [Moreira & Muir — Volatility-Managed Portfolios (JoF 2017)](https://amoreira2.github.io/alan-moreira.github.io/VolPortfolios_published.pdf)
- [FinMem (arxiv 2311.13743)](https://arxiv.org/abs/2311.13743)
- [TradingAgents (arxiv 2412.20138)](https://arxiv.org/abs/2412.20138)
- [FINCON NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/f7ae4fe91d96f50abc2211f09b6a7e49-Paper-Conference.pdf)
- [LLM Agents in Financial Trading: A Survey](https://arxiv.org/html/2408.06361v1)
- [Why fractional Kelly — Matthew Downey simulations](https://matthewdowney.github.io/uncertainty-kelly-criterion-optimal-bet-size.html)
- [pandas-ta-classic GitHub](https://github.com/xgboosted/pandas-ta-classic)
- [Markov/HMM Regime Detection in BTC (Preprints 2026)](https://www.preprints.org/manuscript/202603.0831)
- [Bitcoin Regime Shifts — Bayesian HMM (MDPI 2025)](https://www.mdpi.com/2227-7390/13/10/1577)
- [Quantpedia — Volatility Targeting Intro](https://quantpedia.com/an-introduction-to-volatility-targeting/)
- [Concretum Group — Position Sizing in Trend-Following](https://concretumgroup.com/position-sizing-in-trend-following-comparing-volatility-targeting-volatility-parity-and-pyramiding/)
- [Amberdata — Funding Rates and Perp Swaps](https://blog.amberdata.io/funding-rates-how-they-impact-perpetual-swap-positions)
- [Buildix — BTC Orderflow Analytics on Hyperliquid](https://www.buildix.trade/pair/BTC)
- [Bookmap — CVD Trading Strategy](https://bookmap.com/blog/how-cumulative-volume-delta-transform-your-trading-strategy)
- [Phemex — CVD Indicator Guide](https://phemex.com/academy/what-is-cumulative-delta-cvd-indicator)
