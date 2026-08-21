# 02 — Time-Series & Statistical Methods for the Hypothesis Machine

**Scope.** How agent-wolf should maintain a confidence/validation score for a user-stated market thesis ("gold rises because China is rotating USD reserves into gold") as new evidence batches (price, sentiment, news, on-chain flows) arrive on a configurable schedule.

**Central design constraint.** A thesis can be *right* and the price *temporarily wrong*. The score must distinguish path-dependent noise from genuine invalidation by tracking the **causal mechanism** separately from the **outcome (price)** and weighting them by horizon.

---

## 1. Bayesian Sequential Updating in Practice

The natural primitive: maintain a posterior `P(H | E_{1:t})` over the thesis being true, update it with each evidence batch via Bayes:

```
P(H | E_{1:t}) ∝ P(E_t | H, E_{1:t-1}) · P(H | E_{1:t-1})
```

In a clean i.i.d. world the likelihoods factor and the log-posterior is just the prior plus a sum of log-likelihood-ratios. In our world the evidence is fuzzy, multi-modal, and correlated — so the practical question is what *form* of Bayesian update we run.

### 1.1 Beta-Binomial conjugate update (recommended baseline)

Frame each evidence batch as a Bernoulli trial with two outcomes — the batch was *thesis-supportive* or *thesis-contradicting*. Place a Beta(α, β) prior on the underlying support rate `θ`. After observing `k` supportive batches in `n` recent batches:

```
posterior  = Beta(α + k, β + (n - k))
P(H is right) ≈ E[θ] = (α + k) / (α + β + n)
```

The Beta-Binomial pair is conjugate, so the update is closed-form (no MCMC), commutative, and equivalent under sequential or batch processing ([conjugate prior, Wikipedia](https://en.wikipedia.org/wiki/Conjugate_prior); [STAT 535 notes, Hitchcock](https://people.stat.sc.edu/hitchcock/stat535slides3BRBhandout.pdf)). It is the cheapest sane scoring scheme and trivially implementable in Go without a Python sidecar. The classifier converting fuzzy evidence → `supportive y/n` is where the real work lives (LLM judge with structured output, see §8).

A useful refinement: replace the binary trial with a Beta-distributed *strength score* per batch (an LLM emits `s_t ∈ [0,1]`) and run the update as a [Beta likelihood update](https://allendowney.github.io/ThinkBayes2/chap18.html), or treat `s_t` as soft counts: `α += s_t; β += (1 - s_t)`.

### 1.2 Naive Bayes evidence weighting (multi-source)

For multi-modal evidence (price, social, news, on-chain) treat each channel as conditionally independent given H:

```
log P(H | E_t) ≈ log P(H) + Σ_c log P(E_t^c | H) - log P(E_t^c | ¬H)
```

The independence assumption is a lie — sentiment and price are correlated — but Naive Bayes is famously robust to violation in practice ([Jacquier & Polson, Bayesian Methods in Finance, BU](https://people.bu.edu/jacquier/papers/bayesfinance.2011.pdf)). The likelihood-ratio per channel can be calibrated empirically from past hypotheses (channel `c` was right `r_c%` of the time when it pointed in direction `d`).

### 1.3 Particle filters / Sequential Monte Carlo

When the latent state is continuous and non-linear (e.g. `θ_t` = current "thesis health" drifting through time), use a particle filter ([Lopes & Tsay, *Particle filters and Bayesian inference in financial econometrics*, J. Forecasting 2011](https://hedibert.org/wp-content/uploads/2013/12/lopes-tsay-2011.pdf); [Creal, *Survey of SMC methods for economics and finance*](https://people.bordeaux.inria.fr/pierre.delmoral/creal2009survey-economics-finance.pdf)). Each particle is a sampled trajectory of `θ`; weights are updated by the per-batch likelihood and resampled when ESS drops.

Practical for us only when we want a *time-varying* posterior on a continuous latent (e.g. the strength of the rotation flow). For most hypotheses Beta-Binomial suffices.

### 1.4 Bayesian belief networks / PGMs

A graphical model over `mechanism nodes` (e.g. `China_BoP_outflow`, `PBoC_gold_purchases`, `dedollarization_rhetoric`) and `outcome node` (`gold_price`) lets us encode the user's stated causal chain explicitly. Update each node with its own evidence stream; the posterior on the root `H` flows through the graph. Tools: [PyMC](https://www.pymc.io/), [pgmpy](https://pgmpy.org/), or hand-rolled in NumPy.

### 1.5 Bayes-by-backprop / variational

Useful only if we want a learned likelihood model (NN that scores evidence). For MVP, overkill — but a fallback once we have labeled evidence-batch outcomes.

### 1.6 Library picks

| Library | Strength | Use when |
|---|---|---|
| [PyMC](https://www.pymc.io/) | Friendly DSL, JAX backend (4× CPU, 11× samples/sec on GPU per [pymc-labs benchmark](https://www.pymc-labs.com/blog-posts/pymc-stan-benchmark)) | Belief networks, hierarchical models |
| [NumPyro](https://num.pyro.ai/) | Fastest JAX-based sampler; matched Stan accuracy in [Bayesian IRT comparison (PMC10588711)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10588711/) | Production batch inference |
| [Pyro](https://pyro.ai/) | PyTorch ecosystem, deep generative | If we go Bayes-by-backprop |
| [Stan / cmdstanpy](https://mc-stan.org/) | Battle-tested HMC, gold standard | One-off offline analysis |
| [arviz](https://python.arviz.org/) | Posterior diagnostics across all of the above | Always |

For agent-wolf MVP: closed-form Beta-Binomial in Go, fall back to **NumPyro in a Python sidecar** for anything more elaborate (§7).

---

## 2. Sequential Probability Ratio Test (SPRT)

Wald's classic — minimax-optimal for early stopping ([Wald & Wolfowitz, 1948](https://en.wikipedia.org/wiki/Sequential_probability_ratio_test); [UCB lecture notes](https://ucb-stat-159-s21.github.io/site/Notes/sprt.html); [Statsig docs](https://docs.statsig.com/experiments/advanced-setup/sprt)). After `n` evidence batches, compute the cumulative log-likelihood ratio:

```
Λ_n = Σ_{i=1}^n log [ p(E_i | H_1) / p(E_i | H_0) ]
```

with thresholds derived from desired type-I/II error rates `α, β`:

```
A = log( (1 - β) / α )      # upper threshold → accept H_1 (thesis right)
B = log( β / (1 - α) )      # lower threshold → accept H_0 (thesis wrong)

if Λ_n ≥ A: stop, accept H_1
if Λ_n ≤ B: stop, accept H_0
otherwise:  collect more evidence
```

SPRT minimizes expected sample size among all sequential tests with the same error rates and supports continuous monitoring without alpha-spending penalties — there is "no penalty for peeking" ([Statsig](https://docs.statsig.com/experiments/advanced-setup/sprt)).

**Where it fits us.** SPRT is ideal as a **culling layer** to terminate obviously-wrong (or obviously-right) hypotheses early. Run a permissive SPRT (e.g. `α = β = 0.05`) over the per-batch supportive/contradicting outcomes from the LLM judge: hypotheses whose `Λ_n` blows past `B` get retired; ones that blow past `A` get promoted.

**Where it breaks down.** SPRT assumes a known likelihood ratio under both hypotheses and i.i.d. samples — neither holds for fuzzy market evidence. We have to *fix* `p(E_t | H_1)` and `p(E_t | H_0)` somehow (e.g. assume a "supportive batch" appears 70% of the time under H_1 and 50% under H_0). The approximate-threshold version (Wald's original) is also known to overshoot under heavy-tailed evidence ([Fischer & Ramdas 2024, *Improving Wald's approximate SPRT by avoiding overshoot*](https://arxiv.org/abs/2410.16076)) — for safety, treat SPRT decisions as advisory, not final.

---

## 3. Change-Point Detection

Independent of confirmation, we need to flag when the underlying market regime *itself* shifts so a hypothesis can be re-evaluated (or invalidated automatically because its operating regime no longer exists).

### 3.1 BOCPD (Adams & MacKay 2007)

The reference Bayesian online algorithm ([Adams & MacKay 2007, arXiv:0710.3742](https://arxiv.org/abs/0710.3742); [Princeton PDF](https://lips.cs.princeton.edu/pdfs/adams2007changepoint.pdf); [Gundersen explainer](https://gregorygundersen.com/blog/2019/08/13/bocd/)). Maintains a posterior over the **run-length** `r_t` (time since last change-point). On each new observation:

```
P(r_t = r | x_{1:t}) ∝ Σ_{r_{t-1}} P(x_t | r_{t-1}, x_{(t-r_{t-1}):t-1})
                                   · P(r_t | r_{t-1})  · P(r_{t-1} | x_{1:t-1})
```

Spike in `P(r_t = 0)` ⇒ probable change-point. Recent finance work confirms it cleanly catches COVID and major monetary-policy shifts in S&P 500 / CSI 300 daily log returns ([*BOCPD for Financial Time Series*, ACM 2025](https://dl.acm.org/doi/10.1145/3795154.3795291); [HK stock market evidence, ACM 2025](https://dl.acm.org/doi/10.1145/3778450.3778502)).

### 3.2 CUSUM, PELT, and `ruptures`

For offline / batch retrospective analysis:

- **CUSUM** — cumulative sum of deviations from the running mean; trivial to implement, fast.
- **PELT** (Pruned Exact Linear Time) — exact O(n) segmentation under a penalised cost function; the workhorse in [`ruptures`](https://github.com/deepcharles/ruptures) ([docs](https://centre-borelli.github.io/ruptures-docs/user-guide/detection/pelt/)).
- `ruptures` is BSD-licensed, has a `KernelCPD` C-backend, and supports Dynp/Pelt/Window/BinSeg.

### 3.3 Wiring into the scoring loop

Keep change-point detection **on the input streams** (price, sentiment volume, search-volume), not on the posterior. When `P(r_t = 0) > 0.5` in any tracked stream:

1. Annotate the evidence-batch tick with `regime_break = True`.
2. **Inflate the prior variance** of the thesis posterior (or partially reset toward the prior — e.g. `α, β ← α/2 + α_0/2, β/2 + β_0/2`). This implements "the regime changed; my old evidence is half-stale".
3. Surface the event to the LLM judge so it can re-read the thesis under the new regime.

This decouples *regime change* from *thesis invalidation* — a thesis can survive a regime break if the new regime still supports it.

---

## 4. Forecasting Calibration Metrics

For the *system-level* question — "do our scores actually predict?" — we need proper scoring rules ([Gneiting & Raftery 2007, *Strictly Proper Scoring Rules*, JASA](https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf)).

| Metric | Formula | When to use |
|---|---|---|
| **Brier** | `BS = (1/N) Σ (p_i − o_i)²` | Binary thesis outcomes (right/wrong) |
| **Log score** | `LS = − Σ log p(o_i)` | Heavy penalty for confident-and-wrong; sensitive to 0/1 |
| **CRPS** | `CRPS(F, y) = ∫ (F(x) − 𝟙(x ≥ y))² dx` ([Stan loo docs](https://mc-stan.org/loo/reference/crps.html)) | Continuous outcomes (e.g. predicted vs realised return) |

### 4.1 Murphy decomposition

The Brier score decomposes as `BS = Reliability − Resolution + Uncertainty` ([Wikipedia, Brier score](https://en.wikipedia.org/wiki/Brier_score); [Bröcker, *Decompositions of Proper Scores*](https://pure.mpg.de/rest/items/item_2220390/component/file_2220389/content); [generalisation by Dimitriadis et al., Exeter 2024](https://ore.exeter.ac.uk/articles/journal_contribution/Simplifying_and_generalising_Murphy_s_Brier_score_decomposition/29748851/1/files/56771708.pdf)):

- **Reliability** — are our 70% calls right 70% of the time? (Lower is better.)
- **Resolution** — do we discriminate at all? (Higher is better.)
- **Uncertainty** — base rate variance, model-independent.

We track these per hypothesis-class (macro / micro-cap / sentiment-driven / etc.) and use them to detect *which* parts of the system are mis-calibrated.

### 4.2 Forecasting tournament benchmarks

The benchmark to beat: superforecasters in IARPA's ACE tournament achieved Brier ≈ 0.25 on geopolitical questions ([Tetlock & Mellers; superforecasters research, PMC7333631](https://pmc.ncbi.nlm.nih.gov/articles/PMC7333631/)). Halawi et al. 2024 ([NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a5acfd0876c940d81619c1dc60e7748-Paper-Conference.pdf); [arXiv:2402.18563](https://arxiv.org/pdf/2402.18563)) hit Brier 0.179 with an LLM scratchpad system; the ForecastBench crowd ([Karger et al. 2025, arXiv:2409.19839](https://arxiv.org/pdf/2409.19839)) reached 0.149. [Halley 2025](https://arxiv.org/pdf/2604.18576) introduced *agentic forecasting via sequential Bayesian updating of linguistic beliefs* — close to our exact setup. Aim for `BS ≤ 0.20` system-wide as a non-laughable target.

---

## 5. Distinguishing Thesis-Correct-but-Noisy-Price from Thesis-Wrong

This is the load-bearing methodology for us.

### 5.1 The decomposition

Encode the thesis as a **directed causal chain** of named *mechanism indicators* `M = (m_1, …, m_k)` plus the *outcome* `Y` (price). For "gold rises because China is rotating USD into gold":

| Indicator | Source | Polarity |
|---|---|---|
| `m_1` PBoC monthly gold reserves | PBoC SAFE data | + |
| `m_2` China US-Treasury holdings | TIC report | − |
| `m_3` Chinese dedollarization rhetoric | News/social NLP | + |
| `m_4` Shanghai Gold Exchange premium vs LBMA | Exchange data | + |
| `m_5` PBoC USD/CNY fixings | FX data | context |
| `Y`   spot gold (USD) | price | + (long-horizon) |

Track a **mechanism score** `S_M_t = Σ_i w_i · z(m_i,t)` and an **outcome score** `S_Y_t = z(Y_t)` separately. The combined thesis score is horizon-weighted:

```
S_t(h) = λ(h) · S_M_t + (1 − λ(h)) · S_Y_t
λ(h) = exp(−h / τ)             # h = horizon in days, τ ≈ 90
```

So at h=1d the score is ~99% mechanism, at h=365d it's ~2% mechanism / 98% outcome. **A hypothesis fails only if both `S_M` and `S_Y` deteriorate at the relevant horizon** — if mechanism stays strong but outcome lags, the score holds.

### 5.2 Causal estimation primitives

When the thesis claims a causal effect we can sometimes test directly:

- **Event study** ([Goldsmith-Pinkham, *Causal Inference in Financial Event Studies*](https://paulgp.com/papers/financial_event_studies_nov18.pdf)) — abnormal returns around policy events, central-bank announcements, macro prints. Useful as a per-event evidence shred.
- **Synthetic control** ([Abadie; *Causal Inference for the Brave and True* ch.15](https://matheusfacure.github.io/python-causality-handbook/15-Synthetic-Control.html)) — construct a weighted "synthetic non-China" demand path for gold and compare.
- **Synthetic difference-in-differences** ([Arkhangelsky et al.; ch.25](https://matheusfacure.github.io/python-causality-handbook/25-Synthetic-Diff-in-Diff.html); [Clarke et al. Stata implementation](https://journals.sagepub.com/doi/10.1177/1536867X241297914)) — combines DiD's interpretability with SC's matching, robust when parallel-trends fails.
- **Causal inference for asset pricing** ([Haddad, He, Huebner 2025](https://zhiguohe.net/wp-content/uploads/2025/03/causal_inference_HHHKL_032025.pdf)) — survey of identification strategies for cross-sectional returns.

These are **batch / offline** tools. We run them as periodic deep-evaluation passes (weekly?) and feed the abnormal-return / treatment-effect estimate as a *single evidence batch* into the Bayesian update.

### 5.3 Signal-on-mechanism vs signal-on-outcome

Cornelissen & Werner (2026) on causal mechanisms ([SAGE](https://journals.sagepub.com/doi/10.1177/10944281251318727)) and [Little's encyclopedia entry](https://www-personal.umd.umich.edu/~delittle/Encyclopedia%20entries/Causal%20mechanisms.htm) make the distinction explicit: an outcome can deviate from prediction without the underlying mechanism being wrong (confounders, lags, secondary shocks). Our framework operationalises this by **scoring evidence against the mechanism node it bears on**, never collapsing everything onto price.

---

## 6. Fusing Social/Sentiment + Price

### 6.1 Empirical baselines

- **FEARS index** (Da, Engelberg, Gao 2015, *Sum of All FEARS*, [Review of Financial Studies](https://academic.oup.com/rfs/article-abstract/28/1/1/1682440); [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1509162)) — Google search volume on fear-related terms predicts short-term return reversals, transient volatility spikes, and equity→bond fund flows. Effect is short-horizon and decays.
- **Twitter sentiment for crypto** ([Naeem et al. 2021, *Does Twitter Happiness predict crypto?*](https://onlinelibrary.wiley.com/doi/10.1111/irfi.12339); [Predictive role of online investor sentiment, J. Behavioral Finance](https://www.sciencedirect.com/science/article/abs/pii/S1059056021000083); [Twitter sentiment for crypto forecasting, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S104244312030072X)) — Happiness sentiment is a robust predictor; FEARS-style fear sentiment has weaker, shorter-lived predictability in crypto.
- **News-flow alpha** ([*News Sentiment and Stock Market Dynamics*, MDPI 2025](https://www.mdpi.com/1911-8074/18/8/412); [*Stress-index strategy with news sentiment*, arXiv:2404.00012](https://arxiv.org/html/2404.00012v1); [*Interpretable ML for Macro Alpha*, arXiv:2505.16136](https://arxiv.org/html/2505.16136v1); [*Backtesting Sentiment Signals*, arXiv:2507.03350](https://arxiv.org/abs/2507.03350)) — news sentiment is regime-dependent: a strong predictor during crises, near-noise in placid markets. SHAP analyses reveal mean-reversion at sentiment extremes.

### 6.2 What this implies for us

Sentiment is **two different things** depending on the consumer:

1. **Sentiment-as-feature** (price prediction) — short-horizon, decays in hours/days, flips sign at extremes. Not what we want.
2. **Sentiment-as-evidence-on-mechanism** — does the *narrative* required by the thesis exist and intensify? E.g. for the gold thesis: rising volume of articles citing "BRICS settlement", "PBoC gold purchases", "dedollarization". This is what we score against `m_3`.

Use sentiment as evidence-on-mechanism and let price stand on its own as outcome — never collapse them into a single feature for the score. Lead-lag empirics ([SHAP-based study, 2025](https://www.mdpi.com/1911-8074/18/8/412)) suggest sentiment leads price by 1–5 days for crisis regimes, less in calm — useful when calibrating per-channel likelihoods (§1.2).

---

## 7. Practical Libraries

### 7.1 Python — the heavy lifters

| Library | Why we'd use it |
|---|---|
| [PyMC](https://www.pymc.io/) | Belief networks, hierarchical thesis models, JAX speedups |
| [NumPyro](https://num.pyro.ai/) | Fastest production HMC; stateless workers |
| [Pyro](https://pyro.ai/) | Bayes-by-backprop, deep generative likelihoods |
| [Stan / cmdstanpy](https://mc-stan.org/) | Reference for any model; arbitrary diagnostics |
| [arviz](https://python.arviz.org/) | Always — posterior diagnostics, R-hat, ESS |
| [ruptures](https://github.com/deepcharles/ruptures) | PELT/CUSUM/Window change-point |
| [bocd](https://gregorygundersen.com/blog/2019/08/13/bocd/) | Reference BOCPD impl (also in [PyPI bocd](https://pypi.org/project/bocd/)) |
| [statsmodels](https://www.statsmodels.org/) | Event studies, ARIMA, OLS |
| [scikit-learn](https://scikit-learn.org/) | Calibration curves, `BrierScoreLoss` |
| [scoringrules](https://frazane.github.io/scoringrules/) | CRPS / log-score / energy-score in one place |

### 7.2 Go — honest assessment

- [`gonum/stat`](https://pkg.go.dev/gonum.org/v1/gonum/stat) — solid descriptive stats, distributions, basic regression. ([github](https://github.com/gonum/gonum))
- [`jbrukh/bayesian`](https://github.com/jbrukh/bayesian) — Naive Bayes text classifier. Useful for the LLM-judge fallback only.
- [`probab`](https://github.com/ThePaw/probab) — pure-Go distributions; abandoned but functional.
- [`goptuna`](https://github.com/c-bata/goptuna) — Bayesian *optimization*, not inference.
- No serious analogue to PyMC / NumPyro exists. The Go data-science survey ([gopherdata/resources](https://github.com/gopherdata/resources/blob/master/tooling/README.md)) confirms: ML/Bayesian work is best offloaded.

**Verdict.** Closed-form Beta-Binomial fits comfortably in Go. Anything richer (BOCPD, particle filter, hierarchical PyMC model) goes in a **Python sidecar** invoked over gRPC or HTTP. The Go controller orchestrates schedulers, evidence collection, and storage; the sidecar runs `numpyro.infer.MCMC` or `ruptures.Pelt` on demand.

### 7.3 Hosted

- [AWS Forecast](https://aws.amazon.com/forecast/) — AutoML over DeepAR/Prophet/ETS, designed for retail demand. Wrong primitive: it predicts *the series*, not posterior over a hypothesis. Skip.
- [GCP Vertex AI Forecast](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-forecasting) — now supports probabilistic inference and TimesFM in BigQuery ([Google Cloud blog](https://cloud.google.com/blog/products/data-analytics/timesfm-models-in-bigquery-and-alloydb)). Good for *baseline* price forecasts to compare actual returns against (counterfactual baseline for §5).
- Modal / Beam / Replicate — useful for serverless Python sidecar hosting if we don't want to run our own.

---

## 8. Recommended Approach for agent-wolf MVP

### 8.1 The score we maintain (per hypothesis)

```
HypothesisScore {
  id                  string
  prior               (alpha_0, beta_0)         # user/system prior on thesis
  mechanism_posterior (alpha_M, beta_M)         # Beta-Binomial over mechanism
  outcome_posterior   (alpha_Y, beta_Y)         # Beta-Binomial over outcome
  horizon_days        int                       # τ in λ(h)
  sprt_loglr          float                     # Wald cumulative log-LR
  regime_state        {run_length_dist, last_break_t}
  history             []EvidenceTick
  brier_history       []float                   # for self-calibration
}
```

### 8.2 Per evidence-batch tick — what we store

```
EvidenceTick {
  hypothesis_id   string
  ts              time.Time
  raw_signals     {price, sentiment_score, news_docs[], onchain_metrics{}, ...}
  mechanism_evals []{indicator_id, score ∈ [0,1], rationale}    # LLM-judged
  outcome_eval    {score ∈ [0,1], rationale}                    # price vs prediction
  regime_break    bool
  delta_alpha_M, delta_beta_M, delta_alpha_Y, delta_beta_Y      # for replay
  posterior_after (mech_mean, out_mean, combined)
  sprt_loglr_after float
}
```

Every input is preserved, every update is replayable, and the LLM rationale is stored alongside the numeric delta — critical for debugging and calibration.

### 8.3 Pseudocode — the update step

```python
def update(h: HypothesisScore, batch: EvidenceBatch) -> EvidenceTick:
    # 1. Change-point check on input streams
    cp_score = bocpd.update(batch.price_series, batch.sentiment_series)
    if cp_score.run_length_zero_prob > 0.5:
        h.mechanism_posterior = blend(h.mechanism_posterior, h.prior, w=0.5)
        h.outcome_posterior   = blend(h.outcome_posterior,   h.prior, w=0.5)
        regime_break = True

    # 2. LLM judge -> per-mechanism-indicator scores in [0,1]
    mech_scores = llm_judge.score_mechanism(h.thesis, h.mechanism_indicators, batch)
    s_M = weighted_mean(mech_scores, h.indicator_weights)        # ∈ [0,1]
    s_Y = score_outcome(batch.price_series, h.predicted_direction, h.horizon)

    # 3. Beta-Binomial soft update
    h.mechanism_posterior.alpha += s_M
    h.mechanism_posterior.beta  += (1 - s_M)
    h.outcome_posterior.alpha   += s_Y
    h.outcome_posterior.beta    += (1 - s_Y)

    # 4. Horizon-weighted combined score
    lam = math.exp(-h.horizon_days / TAU)
    combined = lam * mean(h.mechanism_posterior) + (1 - lam) * mean(h.outcome_posterior)

    # 5. SPRT on combined supportive/contradicting -> early termination
    p1, p0 = 0.7, 0.5     # tunable per-hypothesis
    h.sprt_loglr += math.log( bernoulli(combined; p1) / bernoulli(combined; p0) )
    decision = sprt_decide(h.sprt_loglr, alpha=0.05, beta=0.05)

    # 6. Self-calibration
    if h.has_resolved_subclaim(batch):
        h.brier_history.append((combined - resolved_outcome) ** 2)

    return EvidenceTick(...everything above...)
```

### 8.4 Architecture sketch

```
┌────────────────────────────────────────────────────────────┐
│                Go controller (agent-wolf)                  │
│  - Scheduler (cron-per-hypothesis)                         │
│  - Evidence collectors: price, social, news, on-chain      │
│  - Beta-Binomial update (closed-form, no sidecar needed)   │
│  - SPRT logic                                              │
│  - PostgreSQL: HypothesisScore, EvidenceTick, audit log    │
└──────────┬───────────────────────────┬─────────────────────┘
           │ gRPC / HTTP                │ structured-output API
           ▼                            ▼
┌──────────────────────┐      ┌──────────────────────────┐
│  Python stats sidecar │     │  LLM judge (Claude API)  │
│  - ruptures (CPD)    │      │  - per-indicator score   │
│  - NumPyro (PGM,     │      │  - rationale + JSON out  │
│    particle filter)  │      │  - mechanism vs outcome  │
│  - scoringrules      │      │    decomposition         │
│  - arviz diagnostics │      └──────────────────────────┘
└──────────────────────┘
```

**Triggers.** The Go scheduler ticks on each hypothesis's configured interval. It (a) collects new evidence, (b) calls the Python sidecar for change-point detection on raw streams, (c) calls the LLM judge for mechanism/outcome scoring, (d) applies the closed-form Beta-Binomial update in-process, (e) writes the `EvidenceTick` to Postgres, (f) checks SPRT and emits a decision event if breached.

**What runs where.**
- Update step (§8.3): **Go**. Closed-form, hot path.
- BOCPD / particle filter / hierarchical PyMC: **Python sidecar**, called on demand or on a slower cadence (hourly?).
- LLM judge: external API (Claude / local), called once per evidence-batch tick.
- Calibration analytics (Brier decomposition, weekly): **Python sidecar**, batch job.

### 8.5 Why this stack

- **Beta-Binomial** is the smallest sane primitive that supports streaming evidence, has a defensible probability semantics, and runs without a probabilistic-programming runtime.
- **Mechanism / outcome decomposition with horizon-weighted blend** directly addresses the central "right thesis, wrong price" problem and is implementable today.
- **SPRT** culls obviously-dead hypotheses fast without polluting the long-run hypothesis pool.
- **BOCPD** in a sidecar prevents stale priors from outliving the regime that produced them.
- **Brier + Murphy decomposition** gives us system-level self-calibration so we know whether our scores actually predict — the only honest answer to "is the hypothesis machine working?".
- **LLM-as-judge for mechanism scoring** is the only pragmatic way to convert qualitative news/social evidence into the numeric `s_M ∈ [0,1]` the Beta-Binomial wants. Store the rationale; replay-debug aggressively.

The next person can write the working scoring loop directly from §8.3 plus the storage schema in §8.2.

---

## Sources

- Adams & MacKay 2007, *Bayesian Online Changepoint Detection*: [arXiv:0710.3742](https://arxiv.org/abs/0710.3742) · [Princeton PDF](https://lips.cs.princeton.edu/pdfs/adams2007changepoint.pdf) · [Gundersen blog](https://gregorygundersen.com/blog/2019/08/13/bocd/)
- Wald & Wolfowitz; SPRT — [Wikipedia](https://en.wikipedia.org/wiki/Sequential_probability_ratio_test) · [UCB notes](https://ucb-stat-159-s21.github.io/site/Notes/sprt.html) · [Statsig](https://docs.statsig.com/experiments/advanced-setup/sprt) · [Fischer & Ramdas 2024](https://arxiv.org/abs/2410.16076)
- Da, Engelberg, Gao 2015, *Sum of All FEARS* — [RFS](https://academic.oup.com/rfs/article-abstract/28/1/1/1682440) · [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1509162) · [PDF](https://rady.ucsd.edu/faculty/directory/engelberg/pub/portfolios/FEARS.pdf)
- Halawi et al. 2024, *Approaching Human-Level Forecasting with LMs* — [arXiv:2402.18563](https://arxiv.org/pdf/2402.18563) · [NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a5acfd0876c940d81619c1dc60e7748-Paper-Conference.pdf)
- Karger et al. 2025, *ForecastBench* — [arXiv:2409.19839](https://arxiv.org/pdf/2409.19839)
- Tetlock superforecasting research — [PMC7333631](https://pmc.ncbi.nlm.nih.gov/articles/PMC7333631/) · [weighted Brier decomposition, Cambridge](https://www.cambridge.org/core/journals/judgment-and-decision-making/article/weighted-brier-score-decompositions-for-topically-heterogenous-forecasting-tournaments/8172E04F2DBC601DA5D953D4685CA346)
- Gneiting & Raftery 2007, *Strictly Proper Scoring Rules* — [JASA PDF](https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf)
- Brier score & Murphy decomposition — [Wikipedia](https://en.wikipedia.org/wiki/Brier_score) · [Bröcker](https://pure.mpg.de/rest/items/item_2220390/component/file_2220389/content) · [Dimitriadis et al. 2024](https://ore.exeter.ac.uk/articles/journal_contribution/Simplifying_and_generalising_Murphy_s_Brier_score_decomposition/29748851/1/files/56771708.pdf)
- CRPS — [Stan loo docs](https://mc-stan.org/loo/reference/crps.html) · [Lokad explainer](https://www.lokad.com/continuous-ranked-probability-score/)
- Lopes & Tsay 2011, *Particle filters and Bayesian inference in financial econometrics* — [PDF](https://hedibert.org/wp-content/uploads/2013/12/lopes-tsay-2011.pdf) · [Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1002/for.1195)
- Creal, *Survey of SMC for economics and finance* — [PDF](https://people.bordeaux.inria.fr/pierre.delmoral/creal2009survey-economics-finance.pdf)
- Jacquier & Polson, *Bayesian Methods in Finance* — [BU PDF](https://people.bu.edu/jacquier/papers/bayesfinance.2011.pdf)
- Conjugate priors / Beta-Binomial — [Wikipedia](https://en.wikipedia.org/wiki/Conjugate_prior) · [STAT 535](https://people.stat.sc.edu/hitchcock/stat535slides3BRBhandout.pdf) · [Think Bayes ch.18](https://allendowney.github.io/ThinkBayes2/chap18.html)
- PyMC vs Stan benchmark — [PyMC Labs](https://www.pymc-labs.com/blog-posts/pymc-stan-benchmark)
- NumPyro vs PyStan IRT comparison — [PMC10588711](https://pmc.ncbi.nlm.nih.gov/articles/PMC10588711/)
- ruptures — [GitHub](https://github.com/deepcharles/ruptures) · [docs](https://centre-borelli.github.io/ruptures-docs/) · [PELT](https://centre-borelli.github.io/ruptures-docs/user-guide/detection/pelt/)
- Causal inference for finance — [Goldsmith-Pinkham, *Causal Inference in Financial Event Studies*](https://paulgp.com/papers/financial_event_studies_nov18.pdf) · [Haddad, He, Huebner 2025](https://zhiguohe.net/wp-content/uploads/2025/03/causal_inference_HHHKL_032025.pdf) · [Synthetic Control, Facure ch.15](https://matheusfacure.github.io/python-causality-handbook/15-Synthetic-Control.html) · [Synthetic DiD, Facure ch.25](https://matheusfacure.github.io/python-causality-handbook/25-Synthetic-Diff-in-Diff.html) · [Clarke et al., Stata SDID](https://journals.sagepub.com/doi/10.1177/1536867X241297914)
- Causal mechanisms — [Cornelissen & Werner 2026, SAGE](https://journals.sagepub.com/doi/10.1177/10944281251318727) · [Little, U. Mich.](https://www-personal.umd.umich.edu/~delittle/Encyclopedia%20entries/Causal%20mechanisms.htm)
- Sentiment + returns — [Naeem et al. 2021, Twitter Happiness & crypto](https://onlinelibrary.wiley.com/doi/10.1111/irfi.12339) · [Behavioral Finance crypto](https://www.sciencedirect.com/science/article/abs/pii/S1059056021000083) · [Twitter sentiment for crypto forecasting](https://www.sciencedirect.com/science/article/abs/pii/S104244312030072X) · [News Sentiment, MDPI 2025](https://www.mdpi.com/1911-8074/18/8/412) · [Stress index, arXiv:2404.00012](https://arxiv.org/html/2404.00012v1) · [Macro alpha, arXiv:2505.16136](https://arxiv.org/html/2505.16136v1) · [Backtesting sentiment, arXiv:2507.03350](https://arxiv.org/abs/2507.03350)
- BOCPD in finance — [BOCPD for Financial Time Series, ACM 2025](https://dl.acm.org/doi/10.1145/3795154.3795291) · [HK stock market evidence, ACM 2025](https://dl.acm.org/doi/10.1145/3778450.3778502) · [Bayesian Autoregressive BOCPD, arXiv:2407.16376](https://arxiv.org/html/2407.16376v1)
- Agentic forecasting via sequential Bayesian updating — [arXiv:2604.18576](https://arxiv.org/pdf/2604.18576)
- Go ecosystem — [gonum/stat](https://pkg.go.dev/gonum.org/v1/gonum/stat) · [gonum repo](https://github.com/gonum/gonum) · [jbrukh/bayesian](https://github.com/jbrukh/bayesian) · [gopherdata resources](https://github.com/gopherdata/resources/blob/master/tooling/README.md)
- Hosted — [Vertex AI Forecasting](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-forecasting) · [TimesFM in BigQuery](https://cloud.google.com/blog/products/data-analytics/timesfm-models-in-bigquery-and-alloydb)
- Probabilistic programming comparisons — [banditkings PPL comparison](https://www.nelsontang.com/blog/python_ppls_compared/python-ppls-compared.html) · [Carroll, *Tour of PPL APIs*](https://colcarroll.github.io/ppl-api/)
