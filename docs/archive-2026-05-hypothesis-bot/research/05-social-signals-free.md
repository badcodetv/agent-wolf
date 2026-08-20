# 05 — Free & Free-Tier Social, Sentiment & News Sources for Hypothesis Tracking

**Status:** Research brief. **Date:** May 2026. **Scope:** US equities, commodities, BTC/ETH/top-50 crypto. **Memecoins out of scope.** **Budget:** $0/mo for v1.

---

## 0. The framing problem: mechanism-evidence vs. ticker-sentiment

Most "social sentiment" products answer *"are people bullish on $X?"*. That is a **lagging, reflexive signal** — it tells us crowd positioning, not whether the underlying causal story is intact.

For a thesis like *"gold is rising because China is rebalancing FX reserves into gold"*, the bullish/bearish-on-$GLD chatter is nearly useless. What we need is a **mechanism-evidence stream**:

- PBOC monthly gold-reserve announcements (raw tonnage data)
- SAFE "Official Reserve Assets" releases
- IMF COFER quarterly currency-composition data
- BIS papers / speeches on reserve diversification
- Speeches by PBOC governor / SAFE deputies
- News covering Chinese state media positioning on dedollarization
- Commentary from credible China-watchers (Setser, Pettis, Brad McMillan)
- Cross-confirmation: are *other* EM central banks doing the same? (Turkey, India, Poland)

The architecture of this brief reflects that priority: **structured/official sources first, then high-quality news, then social — not the other way around.**

---

## 1. News, press, and official releases

### 1a. GDELT 2.0 — *the keystone source*

GDELT 2.0 is the single most important free source for this project. It ingests global news in 65 languages and updates **every 15 minutes**, applying entity extraction, theme tagging, tone scoring (GCAM ~3,000+ latent dimensions), and geographic coding. It is **100% free with no API key** and is also mirrored in Google BigQuery for unlimited-scale querying. ([GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/), [GKG 2.0 announcement](https://blog.gdeltproject.org/introducing-gkg-2-0-the-next-generation-of-the-gdelt-global-knowledge-graph/))

**Endpoint:** `https://api.gdeltproject.org/api/v2/doc/doc?query=...&mode=...&format=json`

**Key query operators:**
- `theme:ECON_GOLD` or `theme:ECON_CENTRAL_BANK` — GKG canonical themes; thousands of phrases roll up under each
- `"China gold reserves"` — quoted free text
- `near10:"central bank" "gold"` — proximity (within N words)
- `sourcecountry:CH` / `sourcelang:eng` — origin filters
- `tone>5` / `tone<-5` / `toneabs>10` — emotional intensity threshold
- Combine: `(theme:ECON_GOLD OR "PBOC") sourcelang:eng tone<-2`

**Output modes** (`mode=`):
- `ArtList` — flat list of matching articles
- `TimelineVol` / `TimelineVolInfo` — coverage volume over time + top articles per spike
- `TimelineTone` — average tone trajectory
- `TimelineSourceCountry` — geographic distribution of coverage
- `WordCloudThemes` / `WordCloudPersons` / `WordCloudOrgs` — co-occurrence

**Latency:** 15 minutes from publication. **Rate limits:** soft, undocumented; the maintainers throttle abusive callers but a daily-cadence app polling a handful of queries is well inside the safe envelope. For unlimited-scale historical work, mirror the BigQuery datasets. ([Rate limiting blog post](https://blog.gdeltproject.org/ukraine-api-rate-limiting-web-ngrams-3-0/), [Behind the scenes: API quotas](https://blog.gdeltproject.org/behind-the-scenes-api-quotas-the-impact-of-a-fraction-of-a-qps/))

**Why it matters here:** GDELT is the *only* free service that lets us run **mechanism queries by theme/entity** rather than by ticker. We can ask "show me coverage volume + tone of `ECON_GOLD AND China central bank` in English-language sources over the last 30 days, segmented by source country" and get a structured timeseries we can score against.

The Python client `gdeltdoc` ([alex9smith/gdelt-doc-api](https://github.com/alex9smith/gdelt-doc-api)) is the cleanest wrapper.

### 1b. NewsAPI.org

Free tier: **100 requests/day, dev/localhost only, articles delayed**. First paid tier is $449/mo. Practically unusable in production but fine for prototyping. ([NewsAPI pricing](https://newsapi.org/pricing))

### 1c. Newsdata.io & Mediastack

- **Newsdata.io free:** ~200 requests/day, 10 articles per request, 87k+ sources, 6-hour delay. Latest-news endpoint only on free.
- **Mediastack free:** 500 requests/month (≈16/day), HTTP only on free, no historical. ([Newsdata.io pricing](https://newsdata.io/pricing), [Mediastack pricing](https://mediastack.com/pricing))

Both are *complementary* to GDELT but not substitutes. Use as a sanity-check on whether English-language coverage is broader than what GDELT happens to surface.

### 1d. SEC EDGAR — *the gold-standard equity primary source*

Completely free, no key required, JSON REST APIs at `data.sec.gov`, full-text search since 2001, RSS feeds for all filing types. Rate limit: **10 req/s** (very generous). Ownership filings (Form 3/4/5) are a separate RSS toggle. ([SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [EDGAR RSS feeds](https://www.sec.gov/about/rss-feeds))

For equity hypotheses this is irreplaceable — 8-Ks for material events, 13F for institutional positioning, Form 4 for insider buying/selling, 10-K/10-Q for fundamentals, comment letters for SEC scrutiny. Full-text search covers ≥25 years. ([EDGAR Full Text Search](https://www.sec.gov/edgar/search/))

### 1e. US official releases (FRED, BLS, BEA, EIA, Treasury)

- **FRED API** — 840k+ time series aggregating BEA, BLS, Census, OECD; free key, generous limits. ([FRED API docs](https://fred.stlouisfed.org/docs/api/fred/))
- **Federal Reserve Board RSS** — press releases, FOMC statements, H.4.1/H.6/H.8 weekly releases. ([FRB RSS feeds](https://www.federalreserve.gov/feeds/feeds.htm))
- **EIA, BLS, BEA, USDA, Treasury** — all expose JSON APIs and RSS for their release calendars; all free.

### 1f. Foreign central banks

- **PBOC English site** — monthly gold-reserve announcements via `pbc.gov.cn/en` and SAFE "Official Reserve Assets" data category. No first-party RSS for the gold updates specifically; scrape monthly. ([PBOC English announcements](https://www.pbc.gov.cn/en/3688110/3688181/index.html), [Bullionstar PBOC reference](https://www.bullionstar.com/gold-university/central-bank-gold-policies-peoples-bank-china))
- **ECB** — full RSS feeds for press releases, speeches, monetary policy decisions. ([ECB RSS feeds](https://www.ecb.europa.eu/home/html/rss.en.html))
- **BoJ** — no first-party RSS; use site polling or aggregator feeds. ([Central Banking BoJ aggregator](https://www.centralbanking.com/organisations/bank-of-japan-boj))
- **FOMC** — covered by FRB RSS above.

### 1g. Google News RSS

Still works in May 2026 via `https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en`. Unofficial, no SLA, occasional breakage. The official Google News API is gone; RSS + scraping are the only paths. ([Google News scraping guide](https://scrapfly.io/blog/posts/guide-to-google-news-api-and-alternatives))

### 1h. Bing News API — **dead**

Microsoft retired the entire Bing Search family on **August 11, 2025**. Plan around its absence. ([Implicator Bing retirement coverage](https://www.firecrawl.dev/blog/bing-search-api-alternatives))

### 1i. Wikipedia / Wikidata as an "is this entity in the news" proxy

Free, no key. Wikimedia Analytics API gives daily pageviews per article — a useful coincident-attention indicator (e.g., spike in `Gold_reserves_of_the_People%27s_Republic_of_China` pageviews → narrative is mainstream). ([Wikimedia Analytics API](https://wikitech.wikimedia.org/wiki/Analytics/AQS/Pageviews))

---

## 2. Twitter / X — **effectively unavailable on $0 in 2026**

**Honest assessment.** As of February 2026 X moved to pay-per-use as the default with **no free read tier**. The vestigial free tier (1,500 posts/month) is **write-only**; you cannot read or search. Basic is $200/mo for 10k tweet reads, Pro is $5,000/mo. ([Xpoz Twitter API pricing 2026](https://www.xpoz.ai/blog/guides/understanding-twitter-api-pricing-tiers-and-alternatives/), [Postproxy 2026 pricing](https://postproxy.dev/blog/x-api-pricing-2026/))

**Scraping paths:**
- **Nitter:** the public instance network has largely collapsed in 2026 due to X's defensive changes. `ntscraper` is unreliable. ([Scrapfly 2026 scraping guide](https://scrapfly.io/blog/posts/how-to-scrape-twitter), [Nitter alternatives 2026](https://simple-web.org/guides/nitter-alternatives-2026-view-twitter-x-timelines-anonymously))
- **snscrape:** broken across most endpoints, occasional partial functionality on pinned versions.
- **Apify / Tweetscout:** paid, not free.
- **xAI Grok with X Search:** requires X Premium+ ($40/mo) — cheapest legitimate path to read-access if Twitter is non-negotiable, but it is *agentic* not *programmatic*: not a clean API, no structured volumes.

**Verdict for v1:** treat X as **unavailable**. Do not architect around it. If Twitter signal is later judged essential, the cheapest legitimate jump is the **$200/mo Basic tier** — flagged as the upgrade lever in section 9.

---

## 3. Reddit

Free OAuth tier: **100 queries per minute per app, 10/min unauthenticated**, public-data-only, non-commercial-only since the 2023 changes. Personal-research bots are still allowed but pre-approval has tightened in 2025. ([Reddit Data API wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki), [Reddit API rate limits 2026](https://painonsocial.com/blog/reddit-api-rate-limits-guide), [Reddit pre-approval crackdown](https://replydaddy.com/blog/reddit-api-pre-approval-2025-personal-projects-crackdown))

**Historical archives:**
- **Pushshift:** admin-only since 2023. Dead for us.
- **PullPush.io:** 3rd-party Pushshift successor; Reddit-wide full-text search; works in 2026.
- **Arctic Shift:** academic-style archive + API + bulk dumps; better for simple queries; subreddit-level FTS only. ([Arctic Shift on GitHub](https://github.com/ArthurHeitmann/arctic_shift), [Hacker News discussion of Arctic Shift](https://news.ycombinator.com/item?id=44936455))

**Recommended subs (ranked by signal-to-noise for our scope):**
1. r/SecurityAnalysis — fundamental writeups, lowest noise
2. r/investing — broad equity/macro
3. r/stocks — broader, noisier
4. r/Gold, r/Silverbugs, r/oil, r/commodities — mechanism-rich for hard-asset theses
5. r/ethfinance — high-quality ETH research; better than r/ethereum
6. r/Bitcoin, r/CryptoCurrency — high noise, useful for cycle-sentiment
7. r/wallstreetbets — included only as a *contra-indicator* / extreme positioning marker

### 4. StockTwits — free, useful, ticker-only

Free public API, no auth required for the streams endpoint, ~30 most recent messages per ticker per call. Each message carries a user-tagged `Bullish` / `Bearish` label, plus aggregate per-ticker sentiment (24h bull/bear ratio) and message volume. ([StockTwits developers](https://api.stocktwits.com/developers), [StockTwits sentiment API](https://sentiment-v2-api.stocktwits.com/))

**Caveat:** this is *exactly* the ticker-sentiment-not-mechanism pattern we want to de-emphasize. Useful as a *positioning* gauge (is the crowd already on this trade?) but not as mechanism evidence.

---

## 5. Crypto-specific

- **Farcaster (Neynar):** Free tier exists as of 2025; covers reads/feeds/cast lookup. Hard rate-limit numbers are gated behind a dashboard signup. ([Neynar API overview](https://docs.neynar.com/reference/neynar-farcaster-api-overview)) For BTC/ETH/top-50 macro discussion, Farcaster's quality is high but volume is small vs. Twitter — a few hundred relevant casts/day across crypto.
- **LunarCrush:** free tier exists but heavily restricted in 2025–26. The MCP server itself is free; useful API endpoints largely paywalled. Plan around the *Individual* tier ($24-29/mo) if needed, but not in v1. ([LunarCrush pricing](https://lunarcrush.com/pricing))
- **Santiment Sanbase:** free tier gives ~1,000 API calls/month and on-chain/social aggregates with a 24h delay; sufficient for a daily-cadence shadow app on a handful of assets.
- **Discord / Telegram:** legally and technically painful. Discord ToS prohibits self-bots; Telegram requires per-channel join. Skip for v1.

---

## 6. Forums & specialized writing

- **SeekingAlpha:** ToS forbids scraping; behind a hardening paywall. Best path is the official RSS feeds for selected authors (free, public). Scraping the article body is a TOS violation; respect it.
- **Substack RSS:** every Substack publication exposes `/<slug>/feed` — completely free. Curate ~10–20 finance writers (Doomberg, Concoda, Lyn Alden, Hanke, Setser's blog, Pettis, Adam Tooze, etc.).
- **Hacker News (Algolia):** free, no API key, **10,000 req/hour**. Best for "is this idea suddenly being discussed by builders/quants?" ([HN Algolia API](https://hn.algolia.com/api))
- **arxiv / arxiv-sanity:** free, RSS by category (q-fin.*, econ.GN). Daily filter for new papers on "central bank gold", "reserve diversification", etc.

---

## 7. Web search APIs for the LLM deep-research phase

Microsoft killed Bing Search in Aug 2025; Brave killed its free dedicated tier in Feb 2026. Landscape as of May 2026:

| API | Free allowance (2026) | Notes |
|---|---|---|
| **Tavily** | **1,000 credits/mo, no card** | Best citation-ready output. Acquired by Nebius Feb 2026 — roadmap risk. ([buildmvpfast comparison](https://www.buildmvpfast.com/api-costs/ai-search)) |
| **Exa** | **2,000 one-time** searches | Best semantic/neural search. Re-up via paid plan. |
| **Brave Search** | $5/mo credit ≈ 1,000 queries | No longer a true free tier post-Feb-2026. ([Brave free plan 2026](https://costbench.com/software/ai-search-apis/brave-search-api/free-plan/)) |
| **Serper** | 2,500 queries/mo (one-time) | Cheapest paid. |
| **SerpAPI** | 250/mo | Real Google SERPs; small allowance. |
| **Google CSE** | **100 queries/day** | Permanent free. Restricted to a CSE config — fine for whitelisted-domain research. |
| **You.com** | Limited dev tier | Less generous than Tavily/Exa. |

**Recommendation:** **Tavily as primary** (1k/mo free, citation-shaped output), **Google CSE as fallback** (100/day permanent, no-card), **Exa for one-shot semantic discovery** of obscure mechanism essays. That's ~3,000+ free searches/month combined — comfortable for a daily-tick research loop on ≤20 active theses.

---

## 8. Recommended free stack — daily tick

For our exact asset scope, the daily tick per asset class hits these 2-3 sources:

| Asset class | Daily tick |
|---|---|
| **US equities** | (1) GDELT DOC by ticker + thesis-theme; (2) SEC EDGAR RSS for the company CIK + Form 4 ownership feed; (3) Reddit r/SecurityAnalysis + r/investing search for the ticker via PullPush |
| **Commodities (gold/oil/ag)** | (1) GDELT DOC by GKG theme (`ECON_GOLD`, `ENV_OIL`, etc.) with `tone` and `sourcecountry` cuts; (2) Relevant central-bank/agency RSS (PBOC/SAFE for gold, EIA for oil, USDA for ag); (3) Substack RSS bundle for sector writers |
| **BTC/ETH/top-50** | (1) GDELT DOC for asset name + `theme:ECON_CRYPTO`; (2) Santiment free-tier social/on-chain aggregates; (3) Farcaster/Neynar free tier for crypto-native chatter; (4) Reddit r/ethfinance / r/Bitcoin via PullPush |

Cross-asset every tick: HN Algolia, Wikipedia pageviews on the thesis entities, FRED for any cited macro series.

### Worked example — gold/China thesis

**Thesis:** *"Gold rises because China is rebalancing FX reserves into gold, away from US Treasuries."*

**Mechanism evidence the bot collects daily:**

1. **PBOC / SAFE** — poll `pbc.gov.cn/en/3688110/3688181/index.html` and the SAFE Official Reserve Assets page; flag the *monthly* gold-tonnage announcement when published. Compute MoM delta.
2. **IMF COFER** — quarterly currency-composition release; check release calendar daily, ingest when out.
3. **GDELT DOC** queries (run daily, 15-min latency):
   - `query=("PBOC" OR "People's Bank of China") "gold" sourcelang:eng&mode=TimelineVolInfo&timespan=14d`
   - `query=theme:ECON_GOLD ("China" OR "PBOC" OR "SAFE") tone<0&mode=ArtList&maxrecords=75`
   - `query=("dedollarization" OR "de-dollarization" OR "reserve diversification") sourcelang:eng&mode=TimelineTone&timespan=30d`
   - `query=("Treasury holdings" "China") sourcelang:eng&mode=TimelineVol&timespan=30d` — *inverse* mechanism: are they selling USTs?
4. **SEC EDGAR Form 13F + TIC data** — quarterly Treasury International Capital report from Treasury (`home.treasury.gov/data/treasury-international-capital-tic-system`) showing China's UST holdings.
5. **Reddit** (PullPush, daily): `q=("PBOC" OR "China gold" OR "dedollarization") subreddit=Gold OR investing OR commodities`.
6. **Substack RSS** bundle: Brad Setser, Lyn Alden, Doomberg, Luke Gromen, Hanke. Daily pull, full-text scan for `China`, `PBOC`, `gold`, `reserves`, `dedollarization`.
7. **HN Algolia**: `query=PBOC gold OR dedollarization&tags=story&numericFilters=created_at_i>{ts_24h_ago}` — ~10k/hr free.
8. **Wikipedia pageviews** for `Gold_reserves_of_the_People%27s_Republic_of_China`, `Foreign-exchange_reserves_of_China`, `De-dollarisation` — daily; spike = mainstreaming.
9. **Web research (Tavily)**: 3-5 deep queries from the LLM agent: *"BIS speeches 2026 reserve diversification gold"*, *"Russia Turkey India central bank gold purchases 2026"*, *"renminbi swap line expansion 2026"* — cross-confirmation of the *broader* dedollarization mechanism.
10. **GDELT cross-confirmation**: same theme query but `sourcecountry:CH OR RU OR IN OR TR` to detect EM-side narrative coordination.

**What the bot scores:** (a) fact stream — has PBOC kept buying this month? Yes/no. (b) narrative volume — is GDELT coverage of `ECON_GOLD AND PBOC` rising or falling vs. trailing 30d? (c) tone trajectory. (d) cross-confirmation — are other EM CBs adding gold? (e) inverse-leg confirmation — are Chinese UST holdings still falling? (f) mainstreaming — Wikipedia pageviews + HN + Substack hits.

This is the *mechanism dashboard*. Notice that **none of these sources is StockTwits/Twitter sentiment on $GLD**.

---

## 9. Upgrade path — first $200/mo

Three candidates for "the first paid tier that 10× signal quality":

1. **X Basic ($200/mo, 10k tweet reads/mo)** — *highest leverage*. Restores the single biggest gap in our free stack. Even at 10k reads/mo, targeted listing of ~30 high-signal accounts (Setser, Pettis, zerohedge, FedWatcher, central-bank reporters) covers the macro mechanism story. **Recommended first upgrade.**
2. **Newsdata.io / Mediastack paid (~$50–150/mo)** — meaningfully extends paid news coverage but largely overlaps with what GDELT already gives us free. **Skip.**
3. **GDELT** has no premium tier in the conventional sense (the data is all free); for high-volume work, mirror to BigQuery (~$5–20/mo on-demand pricing). **Cheap and recommended even at v1.**
4. **LunarCrush Individual (~$24/mo)** or **Santiment Pro (~$135/mo)** — only worth it if crypto becomes the dominant asset class. Defer.
5. **Bloomberg/Refinitiv/Dow Jones tier** — out of scope at $200; lowest tier is multiple thousands/mo.

**Verdict on upgrade:** the single $200/mo step is **X Basic + a $5–20/mo BigQuery mirror of GDELT.** This 10×s the signal density without committing to the $449 NewsAPI minimum or $5k Bloomberg tier.

---

## Recommended free signal stack (ranked)

| Rank | Stream | Source | Query / endpoint pattern | Free-tier limit | What it tells us | Reliability |
|---|---|---|---|---|---|---|
| 1 | **Mechanism news** | GDELT DOC 2.0 | `api.gdeltproject.org/api/v2/doc/doc?query=theme:X+sourcelang:eng&mode=TimelineVolInfo` | Soft throttle, effectively unlimited at daily cadence | Coverage volume + tone of the *thesis mechanism* by entity/theme | Very high — 12+ years uptime |
| 2 | **Equity primary docs** | SEC EDGAR | `data.sec.gov/submissions/CIK{cik}.json` + RSS | 10 req/s, no key | 8-K material events, Form 4 insider, 13F positioning | Very high — official |
| 3 | **Macro time series** | FRED API | `api.stlouisfed.org/fred/series/observations?series_id=...` | Free key, generous | Reserve assets, rates, CPI, anything quantitative | Very high — official |
| 4 | **Foreign CB releases** | PBOC/SAFE, ECB RSS, BoJ | Polled monthly/weekly | Free | The actual *fact* of central-bank action | High |
| 5 | **Forum signal** | Reddit OAuth + PullPush | `oauth.reddit.com/r/{sub}/search?q=...` and `api.pullpush.io/reddit/search/...` | 100 qpm OAuth | Retail/prosumer narrative, dissenting views | Medium — non-commercial only |
| 6 | **Tech/quant chatter** | HN Algolia | `hn.algolia.com/api/v1/search?query=...&numericFilters=...` | 10k req/hr | Builder-class attention spikes | High |
| 7 | **Long-form research** | Substack RSS bundle | `<pub>.substack.com/feed` | Free | High-quality mechanism essays | High (per-author) |
| 8 | **Attention proxy** | Wikipedia pageviews | `wikimedia.org/api/rest_v1/metrics/pageviews/...` | Free | Mainstreaming of an entity/idea | Very high |
| 9 | **Web research (LLM)** | Tavily + Google CSE + Exa | tavily.com /api/v1/search etc. | 1k/mo + 100/day + 2k one-time | Citation-shaped open-web research | Medium-high |
| 10 | **Equity ticker sentiment** | StockTwits | `api.stocktwits.com/api/2/streams/symbol/{T}.json` | No-auth, ~30 msgs/call | Crowd positioning (contra/confirm) | Medium |
| 11 | **Crypto on-chain/social** | Santiment free + Neynar free | sanbase + api.neynar.com | ~1k calls/mo each | Crypto-native narrative + on-chain | Medium |
| 12 | **General news catch-all** | Newsdata.io free | newsdata.io/api/1/latest | ~200 req/day | Backfill where GDELT misses | Medium |
| 13 | **Twitter/X** | — | — | **None viable on $0** | — | — |

---

## Final verdict

> **Given $0 in 2026, can we collect enough mechanism evidence per daily tick to make this work? Yes — provided we accept that Twitter is unavailable and we route around it via GDELT (theme/entity coverage), SEC EDGAR (primary docs), official central-bank/agency RSS, Reddit + PullPush, Substack RSS, HN Algolia, Wikipedia pageviews, and Tavily+CSE+Exa for LLM-driven deep research; the worked gold/China example shows that the mechanism-evidence dashboard is buildable at $0/day on a daily cadence, and the marginal upgrade lever is X Basic at $200/mo, not paid news.**
