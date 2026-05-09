# Prior Art for the Hypothesis Machine

A research brief surveying systems that turn vague claims into trackable, falsifiable structured beliefs and accumulate evidence for/against them over time. Aimed at lifting concrete schemas, prompts, and scoring rules for our Firebase + Go + Claude Code CLI architecture.

---

## 1. Hypothesis-tracking in institutional finance

The financial industry does not, as a rule, expose its thesis-tracking schemas. The few public artifacts cluster around (a) Bridgewater's "decision-rule" paradigm, (b) AlphaSense / Sentieo's research-management UI, and (c) the well-formalized buy-side stock-pitch template that hedge funds have used for decades.

### Bridgewater — decisions as code

Bridgewater's research process is publicly described as **roughly 99% systematic**: every investment view is reduced to a rule that is back-tested against historical data, including data going back a century, and then continuously re-tested against live outcomes ([Toptal](https://www.toptal.com/finance/business-plan-consultants/ray-dalio-principles), [HedgeCo](https://www.hedgeco.net/news/03/2026/bridgewater-dalios-principles-to-algorithmic-intelligence-the-road-to-5billion.html)). Their AIA Labs unit explicitly frames itself as "encoding, enhancing and scaling [Bridgewater's principles] using ML."

Their **Daily Observations ("the wire")** has been published since 1975 and is described internally as a real-time view into how Bridgewater "is processing the world" ([Bridgewater](https://www.bridgewater.com/50-years-of-the-bridgewater-daily-observations)) — i.e. an ongoing, updateable thesis log rather than a one-off note. PriOS itself is not publicly documented in any searchable detail; what is public is the *philosophy*: a thesis must be a rule, and a rule must be testable against simulated history.

**Lift for our system:** every hypothesis should compile to (i) a back-testable rule expressed in terms of observable signals and (ii) a running journal of "the wire"-style observations attached to it.

### AlphaSense / Sentieo

Sentieo (acquired by AlphaSense in 2022) is explicitly marketed for "the evolution of investment theses" through **annotated documents, shared highlights, and team-visible bookmarks**, plus a Table Explorer for structured KPI tracking, and Smart Summaries / change-detection alerts attached to specific theses ([Sentieo vs AlphaSense](https://sentieo.com/how-we-compare/alphasense/), [IntuitionLabs review](https://intuitionlabs.ai/articles/alphasense-platform-review)). AlphaSense's 2025 "Deep Research" mode runs "dozens of searches across 500M+ documents" and returns a comprehensive output ([AlphaSense Deep Research](https://www.alpha-sense.com/resources/product-articles/introducing-deep-research-in-alphasense/)).

The user-facing data model is roughly: **Watchlist → Thesis (free-text + tags) → linked Documents/Tables/Alerts → Annotation Stream**. Alerts include AI-summarised "what changed and why it matters to your thesis" emails.

### The buy-side stock pitch — a battle-tested schema

The publicly documented hedge-fund stock-pitch / investment-memo structure ([Street of Walls](https://www.streetofwalls.com/finance-training-courses/hedge-fund-training/building-an-investment-thesis/), [Mergers&Inquisitions](https://mergersandinquisitions.com/stock-pitch-guide/)) is the closest thing to a standardized hypothesis spec:

```yaml
recommendation: long | short                # direction
asset:                                       # what
  ticker: ...
  market_cap: ...
  valuation_multiples: ...
thesis:                                      # 2-3 sentences explaining
  - "factor making it mispriced"             # why the market is wrong
catalysts:                                   # 6-12 month events
  hard:                                      # definite events with definite outcomes
    - earnings_2026_q3
    - fda_decision_phase_3
  soft:                                      # may or may not occur
    - emerging_market_launch
risks:                                       # top 2-3 ways thesis is wrong
  - description: ...
    mitigation: ...
expected_return:
  base_case: ...
  bull_case: ...
  bear_case: ...
horizon_months: 6-18
```

VC investment memos (Sequoia's leaked YouTube memo, the DoorDash memo) follow the same general shape but with deal-background, market-size, traction and team sections rather than catalysts ([Visible.vc](https://visible.vc/blog/investment-memo/), [Alexander Jarvis archives](https://www.alexanderjarvis.com/the-confidential-youtube-investment-memo-by-sequoia-you-were-never-meant-to-see/)). The shared backbone is **Thesis → Catalysts (anticipated evidence) → Risks (invalidators) → Bounds**.

### Two Sigma, Point72/Cubist, Citadel

Almost nothing public on schemas. Two Sigma writes about platform thinking and "feature forecasting" — using LLMs to "collapse feature engineering tasks from months to minutes" so that "modeling teams [can] test complex hypotheses as easily as they once counted word frequencies in a transcript" ([Two Sigma platform thinking](https://www.twosigma.com/articles/platform-thinking-three-views-from-two-sigma-leaders/)). Cubist Systematic and Citadel publish nothing usable. Mention here mainly for completeness — the institutional process exists but is closed-source.

---

## 2. Forecasting platforms and methodology

This is where the real schema lifts are. The forecasting community has spent fifteen years formalizing how to write a question that resolves cleanly.

### Metaculus question schema (the gold standard)

Metaculus has a published, enforced format ([Metaculus question writing guide](https://www.metaculus.com/question-writing/), [Question Writing Checklist](https://ai.metaculus.com/help/question-checklist/)):

```
Title:                  short, neutral, matches resolution wording
Question (body):        natural-language version of what is being predicted
Background:             why this matters; high-quality references; primer for forecasters
Resolution Criteria:    explicit, source-bound, leaves no discretion
Fine Print:             edge cases, unit/timezone definitions, ambiguity handlers
Close Time:             when forecasts stop being accepted
Resolve Time:           when the criteria can be checked
Question Type:          binary | numeric (range) | date | multiple-choice
```

The decisive design rule is **the Tetlock Clairvoyance Test**: "if you handed your question to a genuine clairvoyant, could they see into the future and definitively tell you whether your resolution criteria happened?" This is the single most important question generator a hypothesis-spec interview can ask.

### Polymarket

Polymarket markets are gated through a markets team (users can't directly create them) ([Polymarket help](https://help.polymarket.com/en/articles/13364541-how-are-markets-created)). Each market specifies a **resolution source** — sometimes a single authoritative source (Federal Register, NFL.com), sometimes "consensus of credible reporting from multiple independent sources" ([Polymarket resolution](https://docs.polymarket.com/concepts/resolution)). UMA's optimistic oracle resolves disputes via a 2-hour challenge window, possibly escalating to a token-holder vote.

### Manifold Markets

Manifold's API schema (open source) is the cleanest public reference for a forecasting question's data model ([Manifold API docs](https://docs.manifold.markets/api), [Manifold GitHub](https://github.com/manifoldmarkets/manifold)). Approximate shape:

```typescript
{
  id: string,
  question: string,                        // title
  descriptionMarkdown: string,             // body / resolution criteria
  outcomeType: 'BINARY' | 'NUMERIC' | 'PSEUDO_NUMERIC' | 'MULTIPLE_CHOICE' | 'POLL',
  closeTime: number,                       // ms epoch
  resolution: 'YES' | 'NO' | 'MKT' | 'CANCEL' | string,
  resolutionProbability?: number,          // for MKT
  probability: number,                     // current crowd estimate
  totalLiquidity: number,
  uniqueBettorCount: number,
  comments: [...],
  bets: [...]                              // full belief-update timeline
}
```

The history-of-bets array is exactly the **belief-trajectory** primitive we need for "track changes in belief over time."

### Good Judgment Project / IARPA ACE / INFER

The Good Judgment Project (GJP) won all four years of IARPA's Aggregative Contingent Estimation (ACE) tournament by 35%–72% over rivals ([Wikipedia: GJP](https://en.wikipedia.org/wiki/The_Good_Judgment_Project), [AI Impacts](https://aiimpacts.org/evidence-on-good-forecasting-practices-from-the-good-judgment-project/)). The follow-on **Hybrid Forecasting Competition (HFC)** combined humans and machine models, used 2-5 mutually exclusive and exhaustive response options per question, and aggregated using "skill-based weights for forecasters and machine models, accounting for recency of forecasts, and adjusting for overconfidence" ([Hybrid Forecasting paper, AI Magazine 2023](https://onlinelibrary.wiley.com/doi/full/10.1002/aaai.12085)). Hybrid beat human-only on 188 geopolitical questions over 8 months.

### Tetlock's Ten Commandments — the operationalization checklist

The condensed [Good Judgment](https://goodjudgment.com/philip-tetlocks-10-commandments-of-superforecasting/) version is the spine for any guided interview:

1. **Triage** — focus on Goldilocks-zone questions where work pays off (skip clocklike easy and cloud-like impossible).
2. **Decompose** ("Fermi-ize") — break the problem into knowable and unknowable sub-parts.
3. **Strike the right balance between the inside and outside views** — find a base rate (how often does X occur in this reference class?) before reasoning about the specifics.
4. **Strike the right balance between under- and overreaction to evidence** — update incrementally; don't ignore news or overweight it.
5. **Look for the clashing causal forces at work** — embrace dragonfly-eye, multiple perspectives.
6. **Strive to distinguish as many degrees of doubt as the problem permits** — use granular probabilities (53% not 50%).
7. **Strike the right balance between under- and overconfidence** — calibration matters more than boldness.
8. **Look for the errors behind your mistakes but beware of rear-view-mirror hindsight biases** — post-mortem every forecast.
9. **Bring out the best in others and let others bring out the best in you** — teaming.
10. **Master the error-balancing bicycle** — every commandment is a balancing act, not a hard rule.

### Scoring rules

The two strictly-proper rules every forecasting platform uses ([Brier score, Wikipedia](https://en.wikipedia.org/wiki/Brier_score), [Scoring rule, Wikipedia](https://en.wikipedia.org/wiki/Scoring_rule)):

| Rule | Formula | Property |
|------|---------|----------|
| **Brier** | `BS = (p − y)²` where y∈{0,1} | symmetric in over/under-confidence; decomposable into Reliability + Resolution + Uncertainty |
| **Logarithmic** | `LS = − log p` if y=1, `−log(1−p)` if y=0 | penalizes overconfidence harder; equivalent to KL divergence from truth |

For multi-period evidence accumulation we want **time-weighted Brier** (more recent forecasts count more) — the same approach HFC uses.

---

## 3. LLM "deep research" tooling

### Anthropic Claude Research

Anthropic's [multi-agent research engineering writeup](https://www.anthropic.com/engineering/multi-agent-research-system) is the clearest published architecture of any major deep-research mode. Key facts:

- **Lead agent + parallel subagents**: Opus 4 lead spawns 3-5 Sonnet 4 subagents in parallel; each subagent runs an OODA loop (Observe / Orient / Decide / Act) with 3+ tools in parallel.
- **90.2% improvement** over single-agent Opus 4 on internal evals.
- **Token budget explains 80% of variance** in performance — i.e. *spend more tokens, get better results*.
- Public prompts: [`research_lead_agent.md`](https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/prompts/research_lead_agent.md) and `research_subagent.md` in the anthropic-cookbook. The lead agent classifies the query as **depth-first / breadth-first / straightforward** before spawning workers and is instructed to coordinate-not-research.
- Subagent task description requires four fields: **objective, output format, tools/sources guidance, task boundaries**.
- Extended thinking (visible scratchpad) is used by the lead agent for planning.

This is the model we should copy almost verbatim for our research phase: a Go controller orchestrates Claude Code subagents, each scoped to one decomposed sub-question, with shared task boundaries.

### OpenAI Deep Research / o3-deep-research

ChatGPT Deep Research uses a three-step process ([leaked prompt repo](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/tool-deep-research.md), [OpenAI docs](https://platform.openai.com/docs/guides/deep-research)):

1. **Clarification model** — an intermediate model asks the user clarifying questions before research starts.
2. **Prompt rewriting** — turns the user's vague request into a detailed, structured prompt.
3. **Deep research model** — runs the actual searches/reasoning; a second `o3-mini` model summarizes chains of thought for the UI.

It uses MCP servers exposing a `search` + `fetch` interface — a clean abstraction we can reuse.

### Perplexity Deep Research

[Perplexity Deep Research](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research) does "dozens of searches automatically, reads hundreds of sources, reasons through material autonomously," runs 2-4 minutes, uses a "test-time compute (TTC) expansion" framework, and routes queries across multiple backend models.

### Elicit (Ought)

[Elicit Systematic Review](https://elicit.com/blog/systematic-review/) is a guided workflow: enter research question → AI generates **search strategies, screening criteria, data extraction columns** automatically. The user then edits/approves before extraction runs at scale ([Elicit support](https://support.elicit.com/en/articles/3970241)). The UX pattern — "AI proposes the schema, human approves, then run" — is exactly what we want for spec-generation.

### Open-source deep research

| Tool | Architecture | Notes |
|------|--------------|-------|
| [gpt-researcher](https://github.com/assafelovic/gpt-researcher) | "Planner + Execution" agents; LangGraph multi-agent (Browser, Editor, Researcher, Reviewer, Revisor, Writer, Publisher) | `DEEP_RESEARCH_BREADTH` and `DEEP_RESEARCH_DEPTH` env vars control tree exploration |
| [LangChain open_deep_research](https://github.com/langchain-ai/open_deep_research) | Reference impl mirroring Anthropic's pattern | LangGraph-based |
| [FutureSearch](https://github.com/futuresearch/) | "Team of AI researchers and forecasters"; uses "techniques of modern judgmental forecasting"; identifies 3-10 reference classes per question | The closest commercial analogue to what we want |

---

## 4. Spec-generation templates we can lift

### AsPredicted (8 questions, the minimum viable spec)

The AsPredicted preregistration form ([template](https://osf.io/m3spx/), [Data Colada](https://datacolada.org/44)) asks exactly eight questions:

1. **Have any data been collected for this study already?**
2. **What's the main question being asked or hypothesis being tested in this study?**
3. **Describe the key dependent variable(s) specifying how they will be measured.**
4. **How many and which conditions will participants be assigned to?**
5. **Specify exactly which analyses you will conduct to examine the main question/hypothesis.**
6. **Describe exactly how outliers will be defined and handled, and your precise rule(s) for excluding observations.**
7. **How many observations will be collected or what will determine sample size?**
8. **Anything else you would like to pre-register?** (secondary analyses, exploratory variables)

This is the template we should *most directly* steal — every field maps cleanly onto a market hypothesis. Q3 → "what signals will we measure"; Q5 → "what statistical/threshold rule constitutes confirmation"; Q6 → "how do we treat noisy or anomalous data"; Q7 → "how long do we run the test"; Q8 → "secondary signals."

### OSF full Preregistration Template

The longer OSF template adds required fields ([COS preregistration guide](https://www.cos.io/blog/choosing-preregistration-template-guide-for-researchers)):

- **Hypotheses**: must be specific, concise, testable; directional vs non-directional declared; predicted effect optional but encouraged.
- **Study type**: experimental / observational / meta-analysis.
- **Statistical models**: explicit model specification (predictors, outcomes, covariates, model family).
- **Sample size justification**: power analysis or stopping rule.

### Lean UX / Lean Startup

The canonical hypothesis statement is a fill-in-the-blank one-liner ([Tasks.Guru](https://tasks.guru/lean-ux), [etventure](https://www.etventure.com/blog/product-development-through-hypotheses-formulating-hypotheses/)):

```
We believe that [doing X / building Y]
for [audience]
will achieve [outcome].
We will know this is true when we see [measurable signal].
```

Adapted for finance:

```
We believe that [thesis claim]
about [asset / sector / theme]
will result in [price/volume/sentiment outcome] over [horizon].
We will know we are correct when we observe [primary signals].
We will know we are wrong when we observe [invalidators].
```

### Tetlock's question-design checklist (operationalized for our interview)

Combining Metaculus's Clairvoyance Test with the Ten Commandments produces this guided-interview script:

1. **Operationalize the claim**: "Translate 'gold rises because China is converting USD reserves to gold' into a clairvoyant-test question. What would a being who could see the future need to look at to tell us, in 12 months, whether you were right?"
2. **Define the asset & timeframe**: "What asset(s)? What price level? What horizon — 30, 90, 180, 365 days?"
3. **Decompose** (Fermi-ize): "What sub-claims must be true for the main thesis to hold?" e.g.: (a) PBoC actually shifts reserves, (b) the shift is large enough to move gold, (c) no offsetting flows neutralize it.
4. **Find the base rate**: "How often have similar reserve-currency shifts produced this outcome in history?"
5. **Pick observable signals**: COMEX gold futures, GLD ETF flows, PBoC reserve disclosures, gold-related social-media volume, central-bank purchases (WGC data), DXY, CNY/USD, US Treasury holdings reports, etc.
6. **Set thresholds**: "Confirmation = gold up >X% AND PBoC reserves Y% gold within N months. Disinvalidation = gold flat or down with no reserve shift visible."
7. **List invalidators (kill criteria)**: explicit conditions where the thesis is dead even if price still moves the right direction (e.g. "if gold rises but PBoC publishes data showing no reserve shift, the *causal claim* is wrong even if directionally right").
8. **Schedule the check**: "Daily price check, weekly social-volume snapshot, monthly reserve-data update."

### Hybrid template: our v1 spec shape

Synthesising AsPredicted + Metaculus + Lean + the buy-side memo into one JSON schema:

```json
{
  "id": "uuid",
  "owner_uid": "firebase-uid",
  "collaborators": ["uid1", "uid2"],
  "version": 1,

  "natural_language": {
    "user_claim": "Gold rises because China is converting USD reserves to gold",
    "elevator_summary": "PBoC reserve diversification → structural gold demand → higher gold prices over 12-24mo",
    "lean_statement": "We believe that PBoC USD→gold reserve conversion will result in gold up >20% over 18 months. We will know we are right when reserve data confirms shift AND gold breaks $X. We will know we are wrong if reserves flat AND gold flat at 12mo."
  },

  "asset_scope": [
    {"class": "commodity", "ticker": "XAUUSD", "role": "primary"},
    {"class": "etf", "ticker": "GLD", "role": "secondary_proxy"},
    {"class": "fx", "ticker": "USDCNY", "role": "context"}
  ],

  "horizon": {"min_days": 90, "target_days": 540, "max_days": 730},

  "decomposition": [
    {"id": "A", "claim": "PBoC actually shifting reserves USD→gold", "weight": 0.4},
    {"id": "B", "claim": "Shift is large enough to move price", "weight": 0.3},
    {"id": "C", "claim": "No offsetting flows neutralize", "weight": 0.3}
  ],

  "base_rate": {
    "reference_class": "central-bank reserve-asset shifts >5% over 24mo",
    "historical_frequency_outcome": "gold +X% on average; cite WGC quarterly demand reports"
  },

  "signals": [
    {
      "name": "pboc_gold_reserves_pct",
      "source": "WGC central-bank purchases dataset",
      "cadence": "monthly",
      "confirmation_threshold": "+1% YoY",
      "invalidation_threshold": "flat or negative"
    },
    {
      "name": "xauusd_close",
      "source": "exchange",
      "cadence": "daily",
      "confirmation_threshold": ">$X by month 12",
      "invalidation_threshold": "<$Y by month 12"
    },
    {
      "name": "social_volume_gold_china",
      "source": "X/Twitter + Reddit",
      "cadence": "daily",
      "role": "context_only"
    }
  ],

  "resolution": {
    "clairvoyance_test": "An oracle 18mo from now would check: (1) PBoC published reserve-mix data, (2) gold spot vs 2026-05-06 baseline, (3) any disclosed offsetting USD repurchases.",
    "yes_criteria": "All three signals above confirmation_threshold by target_days",
    "no_criteria": "Any decomposition node fails its invalidation_threshold",
    "ambiguous_handlers": [...]
  },

  "kill_criteria": [
    "PBoC explicitly denies gold accumulation in official statement",
    "Gold up >20% but driven by demonstrable non-China factor (e.g. major war + verified flow data)"
  ],

  "current_belief": {
    "p_yes": 0.62,
    "last_updated": "2026-05-06T12:00:00Z",
    "scoring_rule": "brier_time_weighted"
  },

  "belief_history": [
    {"t": "...", "p_yes": 0.50, "trigger_event_id": "..."}
  ],

  "evidence_log": [
    {"t": "...", "signal": "pboc_gold_reserves_pct", "value": 4.8, "delta_p": +0.02, "summary": "...", "sources": [...]}
  ],

  "schedule": {
    "research_cadence_days": 7,
    "deep_research_cadence_days": 30,
    "next_run_at": "..."
  }
}
```

---

## 5. OSS hypothesis trackers and forecasting agents

| Project | What it does | Useful for us |
|---------|--------------|---------------|
| [dannyallover/llm_forecasting](https://github.com/dannyallover/llm_forecasting) | Halawi 2024 NeurIPS paper code: full LLM forecasting pipeline | Reference architecture for the research-and-predict loop |
| [getdatachimp/llm-superforecaster](https://github.com/getdatachimp/llm-superforecaster) | Independent reimplementation of Halawi 2024 | More pragmatic codebase |
| [andyzoujm/autocast](https://github.com/andyzoujm/autocast) | NeurIPS 2022 forecasting questions + news corpus | Training/eval dataset |
| [forecastingresearch/forecastbench](https://github.com/forecastingresearch/forecastbench) | Dynamic, contamination-free LLM forecasting benchmark, updated nightly | Eval harness |
| [Metaculus/metac-bot-template](https://github.com/Metaculus/metac-bot-template) | Forks-and-runs forecasting bot template | Production runtime pattern (cron every 30min, GitHub Actions) |
| [Metaculus/forecasting-tools](https://github.com/Metaculus/forecasting-tools) | TemplateBot framework with research/predict/aggregate hooks | Inheritable abstractions |
| [HuggingFace FutureBench](https://github.com/huggingface/blog/blob/main/futurebench.md) | HF blog/space tracking LLM forecast accuracy | Public leaderboard data |
| [assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher) | Multi-agent deep researcher with explicit BREADTH/DEPTH knobs | Drop-in research engine candidate |
| [METR autonomy evals](https://metr.github.io/autonomy-evals-guide/) | HCAST + RE-Bench task suites | Eval framework, not directly forecasting |

### Halawi 2024 — pipeline detail

The Halawi system is the most directly relevant prior art ([arXiv 2402.18563](https://arxiv.org/pdf/2402.18563), [paper PDF NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a5acfd0876c940d81619c1dc60e7748-Paper-Conference.pdf)). The retrieval step has 4 sub-steps:

1. **Search-query generation** (LLM expands the question).
2. **News retrieval** (web search APIs).
3. **Relevance filtering & re-ranking** (GPT-3.5-Turbo rates each article; low-scoring articles dropped).
4. **Text summarization** (per-article summaries to keep context bounded).

The reasoning prompt has four explicit components:

1. **Rephrase** the question (forces comprehension; expand with model knowledge).
2. **Generate arguments for AND against** the outcome from retrieved + pretrained context.
3. **Weight arguments by importance** and produce an initial forecast.
4. **Calibration step**: "check if you are over- or under-confident; consider historical base rates; amend prediction."

Final output is aggregated across multiple sampled chains. **Result: matches aggregate of competitive human forecasters on Brier score.** This is the closest prior art to what we are building, and its prompt structure should be lifted almost verbatim for our per-cycle update step.

The Halawi reasoning template approximates:

```
QUESTION: {q}
DESCRIPTION: {d}
RESOLUTION: {r}
DATES: {dates}
RETRIEVED ARTICLES: {summaries}

Step 1 — Rephrase the question in your own words and expand with relevant background.
Step 2 — List arguments for YES.
Step 3 — List arguments for NO.
Step 4 — Weight arguments by importance and produce an initial probability.
Step 5 — Check calibration: am I over/underconfident given the base rate? Adjust.
FINAL: {p in [0,1]}
```

---

## 6. Top-3 patterns to combine for our system

### Pattern 1 — UX metaphor: **forecasting question + buy-side memo, hybrid**

The hypothesis page should look like a **Metaculus-style question** with an **investment-memo decomposition panel** beneath it.

- Top: title, current crowd-of-evidence p_yes, belief-trajectory chart over time, close/resolve dates.
- Middle: Lean-statement one-liner; collapsible decomposition tree.
- Right: live evidence feed with delta_p annotations (Sentieo-style change alerts).
- Bottom: kill-criteria checklist with auto-fill status.

Avoid the pure dashboard metaphor (too detached from the *causal claim*); avoid the pure memo metaphor (too static). Forecasting question is the load-bearing primitive because it forces falsifiability via the Clairvoyance Test.

### Pattern 2 — Spec fields, ranked by load-bearing-ness

A v1 hypothesis spec must contain these and only these (everything else is gold-plating):

1. **Natural-language claim** + **Lean-statement one-liner** (free text)
2. **Asset scope** (typed: ticker + class + role)
3. **Horizon** (min/target/max days)
4. **Decomposition** (sub-claims with weights summing to 1)
5. **Base rate / reference class** (free text + cite)
6. **Signals** (name, source, cadence, confirmation_threshold, invalidation_threshold)
7. **Resolution**: clairvoyance_test paragraph + yes_criteria + no_criteria + ambiguity_handlers
8. **Kill criteria** (explicit invalidators that don't depend on price)
9. **Schedule** (research_cadence_days, deep_research_cadence_days)
10. **Belief state**: current p_yes + history of (t, p_yes, trigger_event_id)
11. **Evidence log**: append-only stream of (t, signal, value, delta_p, summary, sources[])

Fields 1-9 come from the spec-generation interview (one-shot). Fields 10-11 are written by the scheduled research worker.

### Pattern 3 — Decomposition + scoring + scheduling

- **Decomposition**: copy Halawi's "rephrase → arguments-for → arguments-against → weight → calibrate" reasoning chain *plus* the Tetlock decomposition step ("break into sub-claims with weights"). Store the sub-claims as first-class objects; allow each to have its own signals.
- **Scoring rule**: time-weighted Brier on the top-level p_yes, plus per-decomposition-node sub-scores. Brier (not log score) is the better choice because we'll be computing it incrementally and the symmetry makes the dashboard interpretable. Decompose Brier into Reliability + Resolution + Uncertainty for the post-mortem view.
- **Schedule**: tiered cadence — daily price/sentiment poll (cheap), weekly retrieval-augmented LLM update (medium cost, mirrors Halawi pipeline), monthly multi-agent deep-research re-evaluation (Anthropic-style lead+subagents, expensive). Each tier writes one entry to belief_history if Δp > threshold.

### Pattern 4 (bonus) — Spec-generation interview pattern

Lift Elicit's "AI proposes schema, human approves" UX, OpenAI Deep Research's "clarification model + prompt rewrite" front door, and the AsPredicted 8 questions as the minimum field set. Concrete flow:

```
User types claim
  ↓
Claude (clarification phase):
  - Run Clairvoyance Test out loud
  - Ask: asset? horizon? what would prove this wrong?
  - Ask: what reference class?
  ↓
Claude (deep-research phase, multi-agent):
  - Lead agent decomposes the claim into 2-5 sub-claims
  - Subagents in parallel: (i) find historical base rate, (ii) identify available data sources for each sub-claim, (iii) scan recent news for current state, (iv) propose signal thresholds
  ↓
Claude (spec-emit phase):
  - Emit the JSON schema above
  - Show user side-by-side with their original claim
  ↓
Human approves / edits / commits
  ↓
Schedule kicks in
```

---

## Summary

The closest prior art for our system is, in order:

1. **Halawi et al. 2024** — the actual research+forecast loop, MIT-licensed Python.
2. **Anthropic Claude Research** — the orchestrator/subagent shape and prompt files.
3. **Metaculus question schema + Tetlock Clairvoyance Test** — the load-bearing schema for falsifiability.
4. **AsPredicted 8 questions** — the minimum viable interview script.
5. **Buy-side stock-pitch template (catalysts + risks + horizon)** — the financial-domain framing.
6. **Lean Startup hypothesis statement** — the user-facing one-liner.
7. **Manifold Markets' open API** — the cleanest reference data model for a tracked question.

A v1 of our spec-generation prompt should: (a) run a clarification phase that asks the AsPredicted-8 questions adapted to markets, (b) run an Anthropic-style multi-agent research phase with explicit lead/subagent prompts, (c) emit the JSON schema in §4, and (d) start a tiered schedule that writes a Halawi-style belief update per cycle scored by time-weighted Brier.

---

## Sources

- [Bridgewater — 50 Years of the Daily Observations](https://www.bridgewater.com/50-years-of-the-bridgewater-daily-observations)
- [Bridgewater — Greg Jensen on Algorithmic Decision Making](https://www.bridgewater.com/research-and-insights/greg-jensen-on-algorithmic-decision-making-and-artificial-intelligence)
- [Toptal — Bridgewater Principles](https://www.toptal.com/finance/business-plan-consultants/ray-dalio-principles)
- [HedgeCo — Bridgewater AIA Labs](https://www.hedgeco.net/news/03/2026/bridgewater-dalios-principles-to-algorithmic-intelligence-the-road-to-5billion.html)
- [AlphaSense Deep Research](https://www.alpha-sense.com/resources/product-articles/introducing-deep-research-in-alphasense/)
- [Sentieo vs AlphaSense (thesis tracking)](https://sentieo.com/how-we-compare/alphasense/)
- [IntuitionLabs — AlphaSense platform review](https://intuitionlabs.ai/articles/alphasense-platform-review)
- [Two Sigma — Platform Thinking](https://www.twosigma.com/articles/platform-thinking-three-views-from-two-sigma-leaders/)
- [Sequoia YouTube investment memo (leaked)](https://www.alexanderjarvis.com/the-confidential-youtube-investment-memo-by-sequoia-you-were-never-meant-to-see/)
- [Visible.vc — Investment Memo template](https://visible.vc/blog/investment-memo/)
- [Street Of Walls — Building an Investment Thesis](https://www.streetofwalls.com/finance-training-courses/hedge-fund-training/building-an-investment-thesis/)
- [Mergers&Inquisitions — Stock Pitch Guide](https://mergersandinquisitions.com/stock-pitch-guide/)
- [Metaculus — Question Writing Guide](https://www.metaculus.com/question-writing/)
- [Metaculus — Question Writing Checklist](https://ai.metaculus.com/help/question-checklist/)
- [Metaculus — Question Types](https://www.mintlify.com/Metaculus/metaculus/guides/question-types)
- [Metaculus — FAQ](https://www.metaculus.com/faq/)
- [Polymarket — Resolution docs](https://docs.polymarket.com/concepts/resolution)
- [Polymarket — How markets are created](https://help.polymarket.com/en/articles/13364541-how-are-markets-created)
- [Polymarket — How markets are resolved](https://help.polymarket.com/en/articles/13364518-how-are-prediction-markets-resolved)
- [Manifold — API docs](https://docs.manifold.markets/api)
- [Manifold — GitHub](https://github.com/manifoldmarkets/manifold)
- [Wikipedia — Good Judgment Project](https://en.wikipedia.org/wiki/The_Good_Judgment_Project)
- [Wikipedia — Aggregative Contingent Estimation Program](https://en.wikipedia.org/wiki/Aggregative_Contingent_Estimation_Program)
- [IARPA — ACE program](https://www.iarpa.gov/research-programs/ace)
- [IARPA — Hybrid Forecasting Competition launch](https://www.iarpa.gov/newsroom/article/iarpa-launches-hybrid-forecasting-competition-to-improve-predictions-through-human-machine-integration)
- [Hybrid Forecasting paper, AI Magazine 2023 (open access)](https://onlinelibrary.wiley.com/doi/full/10.1002/aaai.12085)
- [AI Impacts — Good forecasting practices](https://aiimpacts.org/evidence-on-good-forecasting-practices-from-the-good-judgment-project/)
- [Good Judgment — Tetlock's 10 Commandments](https://goodjudgment.com/philip-tetlocks-10-commandments-of-superforecasting/)
- [Farnam Street — Ten Commandments for Superforecasters](https://fs.blog/ten-commandments-for-superforecasters/)
- [LessWrong — Ten Commandments for Aspiring Superforecasters](https://www.lesswrong.com/posts/dvYeSKDRd68GcrWoe/ten-commandments-for-aspiring-superforecasters)
- [Wikipedia — Brier score](https://en.wikipedia.org/wiki/Brier_score)
- [Wikipedia — Scoring rule](https://en.wikipedia.org/wiki/Scoring_rule)
- [Cultivate Labs — Brier score explainer](https://www.cultivatelabs.com/crowdsourced-forecasting-guide/what-is-a-brier-score-and-how-is-it-calculated)
- [Anthropic — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [anthropic-cookbook — research_lead_agent.md](https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/prompts/research_lead_agent.md)
- [anthropic-cookbook — research_subagent.md](https://github.com/anthropics/anthropic-cookbook/blob/46f21f95981e3633d7b1eac235351de4842cf9f0/patterns/agents/prompts/research_subagent.md)
- [Simon Willison's notes on Anthropic's multi-agent post](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/)
- [OpenAI — Deep Research API guide](https://platform.openai.com/docs/guides/deep-research)
- [OpenAI — Deep Research System Card (PDF)](https://cdn.openai.com/deep-research-system-card.pdf)
- [Leaked OpenAI Deep Research system prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/tool-deep-research.md)
- [Perplexity — Deep Research blog](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research)
- [Perplexity — Sonar Deep Research model](https://docs.perplexity.ai/getting-started/models/models/sonar-deep-research)
- [Elicit — Systematic Review blog](https://elicit.com/blog/systematic-review/)
- [Elicit — Guided systematic review workflow](https://support.elicit.com/en/articles/3970241)
- [gpt-researcher — GitHub](https://github.com/assafelovic/gpt-researcher)
- [gpt-researcher — config docs](https://github.com/assafelovic/gpt-researcher/blob/master/docs/docs/gpt-researcher/gptr/config.md)
- [LangChain open_deep_research](https://github.com/langchain-ai/open_deep_research)
- [FutureSearch — GitHub org](https://github.com/futuresearch/)
- [FutureSearch — product page](https://futuresearch.ai/)
- [Halawi et al. 2024 — arXiv](https://arxiv.org/abs/2402.18563)
- [Halawi et al. 2024 — NeurIPS PDF](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a5acfd0876c940d81619c1dc60e7748-Paper-Conference.pdf)
- [Halawi et al. 2024 — code](https://github.com/dannyallover/llm_forecasting)
- [llm-superforecaster reimpl](https://github.com/getdatachimp/llm-superforecaster)
- [Andy Zou — autocast (NeurIPS 2022)](https://github.com/andyzoujm/autocast)
- [ForecastBench — main repo](https://github.com/forecastingresearch/forecastbench)
- [ForecastBench — datasets](https://github.com/forecastingresearch/forecastbench-datasets)
- [HuggingFace blog — FutureBench](https://github.com/huggingface/blog/blob/main/futurebench.md)
- [Metaculus metac-bot-template](https://github.com/Metaculus/metac-bot-template)
- [Metaculus forecasting-tools framework](https://github.com/Metaculus/forecasting-tools)
- [METR — Autonomy Evaluation Resources](https://metr.github.io/autonomy-evals-guide/)
- [METR — Research](https://metr.org/research/)
- [AsPredicted — home](https://aspredicted.org/)
- [AsPredicted — OSF template](https://osf.io/m3spx/)
- [Data Colada #44 — AsPredicted preregistration](https://datacolada.org/44)
- [COS — Choosing the right preregistration template](https://www.cos.io/blog/choosing-preregistration-template-guide-for-researchers)
- [OSF — Templates of Registration Forms](https://osf.io/zab38/wiki/home/)
- [Tasks.Guru — Lean UX hypothesis template](https://tasks.guru/lean-ux)
- [etventure — Hypothesis-driven product development](https://www.etventure.com/blog/product-development-through-hypotheses-formulating-hypotheses/)
- [LessWrong — Falsifiable and non-Falsifiable Ideas](https://www.lesswrong.com/posts/aBsM3q9mtq5KfSJBz/falsifiable-and-non-falsifiable-ideas)
- [Wikipedia — Falsifiability](https://en.wikipedia.org/wiki/Falsifiability)
- [Issues in the Probability Elicitation Process of Expert-Based Bayesian Networks (IntechOpen)](https://www.intechopen.com/chapters/64149)
- [Balancing Elicitation Burden in Bayesian Networks (Risk Analysis 2022)](https://onlinelibrary.wiley.com/doi/full/10.1111/risa.13772)
