# Free Market-Data Sources for Daily-Cadence Hypothesis Tracking

**Status:** Research brief, May 2026
**Scope:** Daily EOD (occasionally weekly) price + macro data for the agent-wolf hypothesis-tracking app, paper-only phase. No intraday, no streaming, no HFT.
**Constraint:** v1 must run on $0/mo. Paid upgrade path noted but not required.
**Universe:** ~5,000 US equities/ETFs/indexes; ~10 commodity series (spot + front-month futures); top-50 crypto by market cap; macro anchors (DXY, UST yields, FedFunds, CPI/PCE, official-sector gold reserves, Chinese FX reserves).

---

## 1. US Equity EOD Providers

| Vendor | Free-tier limit (May 2026) | Hist. depth | Splits/divs adj. | Verdict |
|---|---|---|---|---|
| **Stooq** (web CSV) | Unmetered bulk CSV; no API key | 20+ yrs (varies by ticker) | Adjusted close present | **Top free pick** for bulk universe seeding |
| **Yahoo Finance** via `yfinance` | None advertised; ~2k/hr soft IP cap | 30+ yrs | Yes (`auto_adjust=True`) | **Top free pick** for incremental refresh — but ToS gray |
| **Alpha Vantage** | **25 req/day**, 5/min ([source](https://www.alphavantage.co/support/)) | 20+ yrs | Yes | Hobby-only — daily cap kills universe refresh |
| **Tiingo** | **50 unique symbols/hr**, 1k req/day | 30+ yrs (US listed) | Yes | Solid backup; slow incremental refresh |
| **Twelve Data** | 800 req/day, 8/min | ~10 yrs free | Yes | Tight for 5k universe |
| **EODHD** | **20 req/day**, 1 yr depth on free | 30 yrs paid | Yes | Free tier essentially demo-only |
| **Polygon.io** | 5 req/min, EOD only | 2 yrs free | Yes | Free tier too tight for breadth; cheapest paid step ($29 Starter) |
| **Marketstack** | **100 req/month** | 30 yrs | Yes | Free tier unusable for production refresh |
| **SEC EDGAR** | 10 req/sec, no key, User-Agent required | All 10-K/Q history | n/a (fundamentals) | **Indispensable** for fundamentals — totally free |
| **FRED** | 120 req/min (free key) | Decades | n/a (mostly index) | Best for ETF aggregates / macro series |

**IEX Cloud:** retired August 31, 2024 ([Alpha Vantage migration analysis](https://www.alphavantage.co/iexcloud_shutdown_analysis_and_migration/)). Common replacements are Polygon, Tiingo, Alpha Vantage, Financial Modeling Prep, Databento.

### Ranking (free-tier production fit)

1. **Stooq + yfinance** combo. Stooq seeds the historical archive in one cold-start CSV pull; yfinance handles the daily delta on ~5k symbols. Together this is the only realistic free-tier path that fits the breadth requirement.
2. **Tiingo** as resilience backup — registered free tier is ToS-clean and survives a Yahoo outage, at the cost of slow refresh (50 symbols/hour ≈ a full universe refresh in ~4 days, so use it as a sanity-check not primary).
3. **SEC EDGAR** for fundamentals (P/E, P/B, share count, insider holdings) — the official, free, no-rate-limit-of-significance source ([SEC EDGAR API guide 2026](https://tldrfiling.com/blog/sec-edgar-api-guide/)).
4. **Alpha Vantage / Twelve Data** — both have free tiers but the daily caps (25/day and 800/day) make them auxiliary at best. Use them for 1–2 specific symbols where you need an extra cross-check.
5. **Polygon free / Marketstack free / EODHD free** — effectively demo accounts in May 2026. Skip for v1.

### Yahoo Finance ToS gotcha

The `yfinance` README explicitly notes: *"yfinance is not affiliated, endorsed, or vetted by Yahoo, Inc. It's an open-source tool that uses Yahoo's publicly available APIs, and is intended for research and educational purposes."* ([yfinance PyPI](https://pypi.org/project/yfinance/)). The Yahoo Developer API ToS technically restricts to personal use; commercial use requires a licensed provider ([Yahoo Developer ToS](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html)). **For a paper-only research app this is widely considered tolerable**, but the moment we monetize or publish trade signals derived from Yahoo data, we move to Tiingo/Polygon.

---

## 2. Commodities EOD

| Source | Coverage | Cadence | Free? | Notes |
|---|---|---|---|---|
| **FRED** | WTI, Brent, HH gas, gold (London PM via WGC), copper, ag majors | Daily/weekly/monthly | Yes (key, 120/min) | Deep history, official, recommended primary |
| **Yahoo (yfinance)** | `GC=F`, `CL=F`, `NG=F`, `HG=F`, `ZC=F`, `ZW=F`, `ZS=F` (front-month futures) | Daily | Yes (gray ToS) | Best front-month futures source |
| **Stooq** | Front-month futures + spots, indexes | Daily | Yes (CSV bulk) | Good cross-check |
| **World Bank Pink Sheet** | ~70 commodities, monthly | Monthly | Yes ([Pink Sheet](https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/world-bank-commodities-price-data-the-pink-sheet)) | Authoritative monthly reference; XLSX |
| **LBMA Gold/Silver Fix** | Au/Ag/Pt/Pd auction prices | Daily | JSON feed `prices.lbma.org.uk/json/gold_pm.json` (gray licensing) | Official fix is licensed via ICE-IBA; the JSON is publicly served but commercial redistribution requires a license |
| **Nasdaq Data Link (was Quandl)** | CFTC COT, some legacy commodity series | Weekly/daily | Free with concurrency-1 limit | Some legacy free datasets remain |
| **EIA** | Crude, gasoline, distillate, nat gas, electric | Daily/weekly | Yes (free key, no rate limit published) | Gold-standard for US energy ([EIA Opendata](https://www.eia.gov/opendata/)) |
| **USDA NASS / Quick Stats** | Ag production, prices | Weekly/monthly | Free key | For ag fundamentals; price data shallow |
| **CME / ICE** | Settlement prices | Daily | Public summary CSVs but no proper API; redistribution restricted | Use as auditing source not pipeline source |

### Ranking

1. **FRED** for spot/benchmark series (WTI, Brent, HH gas, London gold, copper LME, USDA ag prices) — the cleanest free pipeline, tens-of-years history, 120 req/min headroom.
2. **yfinance front-month futures tickers** (`CL=F`, `GC=F`, `NG=F`, `HG=F`, `ZC=F`, `ZW=F`, `ZS=F`) — only realistic free source of daily futures settlement-equivalent prices. Comes with Yahoo's continuous-front-month splice quirks: when contracts roll, the series steps; document this.
3. **EIA API** for energy fundamentals (inventories, production, refinery utilization) when an oil/gas hypothesis needs supply-side evidence.
4. **World Bank Pink Sheet** monthly Excel for cross-asset commodity index sanity checks (especially ag and metals).
5. **Stooq** as a free third opinion on futures.

### Gotchas

- **Front-month rolls:** Yahoo `=F` tickers are continuous-front-month with no roll adjustment. For multi-year backtests this introduces phantom jumps.
- **LBMA fix:** the JSON endpoints are publicly served but LBMA's commercial-redistribution license is enforced for downstream products. Fine for internal research; not fine for a public-facing chart.
- **CME public CSVs:** settlement files are publicly downloadable but ToS prohibits redistribution and many endpoints rate-limit by IP.

---

## 3. Crypto Majors EOD

| Vendor | Free tier (May 2026) | History | Notes |
|---|---|---|---|
| **CoinGecko Demo** | **30 calls/min, 10k/month** ([rate-limit doc](https://support.coingecko.com/hc/en-us/articles/4538771776153)) | Years (varies) | Free Demo key is the right baseline for top-50 daily |
| **CoinMarketCap Basic** | 10k credits/month, 30 req/min, **no historical on free** | n/a free | Skip for our purpose |
| **Binance public (`/api/v3/klines`)** | **2400 weight/min/IP, no auth** ([limits](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits)) | Years | The most generous free OHLC source for the top liquid pairs |
| **Kraken public OHLC** | ~1 req/sec/IP; **only 720 candles per call** | Limited via REST; full history via downloadable CSV ZIP | Use the [downloadable historical CSV ZIP](https://support.kraken.com/articles/360047124832) once, then incremental |
| **Coinbase Exchange API** | 10 req/sec public; OHLC max 300 candles/call | Years | Good cross-check |
| **CryptoCompare** | 100k calls/mo, 50 req/sec; daily/hourly history full | Years | Strong free aggregator; min-data beyond 7 days is enterprise |
| **Messari free** | **20 req/min**, basic market data only | Years (basic) | Best for fundamentals/on-chain; deep metrics gated |
| **Glassnode / IntoTheBlock** | Tiny free tiers; most metrics paid | n/a | Skip on free; known upgrade target |
| **Hyperliquid public info** | Free public REST/WS | Recent | Useful for funding/perps macro signals only |

### Ranking

1. **CoinGecko Demo key** — the cleanest free aggregate source. 30/min × 60 = 1,800/hr is plenty for top-50 daily. ToS-clean, no scraping concerns.
2. **Binance public klines** for spot OHLC where deeper, exchange-level fidelity matters. No key, generous limit.
3. **CryptoCompare free** as backup aggregator (different methodology than CoinGecko, useful as sanity check).
4. **Messari free** for fundamentals/on-chain (supply schedules, staking ratios) — supplements price data with thesis-mechanism evidence.

### Gotchas

- **CMC**: zero historical on free tier; misleadingly headline-friendly.
- **Stablecoin pegs** vary across aggregators; CoinGecko reports volume-weighted average, Binance reports its own book — they will disagree by basis points.
- **Weekend gaps:** crypto runs 24/7, but EOD timestamping conventions differ (CoinGecko uses 00:00 UTC; Binance kline candles open at the requested timestamp). Pick one and document.

---

## 4. Macro / Rates / FX

| Source | Coverage | Free? | Notes |
|---|---|---|---|
| **FRED** | UST yields (DGS3MO–DGS30), FedFunds, CPI/CPIAUCSL, PCE/PCEPI, DTWEXBGS (broad USD), gold reserves (BOGZ1FL713011303Q), Chinese reserves (TRESEGCNM052N) | Yes (free key, 120/min) | **Primary** for everything macro |
| **ECB Statistical Data Warehouse** | EUR rates, EU inflation, EUR FX | Yes, no key required | Primary for EU-side macro |
| **World Bank Indicators API** | Global GDP, CPI, FX reserves | Yes, no key | Cross-country aggregates |
| **IMF SDMX/JSON** | International reserves, BOP | Yes, no key | Quarterly/annual |
| **Frankfurter (frankfurter.dev)** | ECB reference FX, **200 currencies, daily back to 1999** ([frankfurter.dev](https://frankfurter.dev/)) | **Yes, no key, no usage limits** | **Replaces exchangerate.host** — currently the cleanest free FX API |
| **exchangerate.host** | Multi-currency + crypto + metals | Free + paid tiers ([pricing](https://exchangerate.host/pricing)) | Went paid-first in 2024; free plan now restored but limited |
| **OpenExchangeRates / Fixer / Currencylayer** | FX | Free tiers exist but small (~1k/mo) | Skip; Frankfurter is better |
| **PBOC, SAFE** | Chinese FX reserves | Free, monthly, manual scrape | Use FRED's mirror (`TRESEGCNM052N`) instead |
| **World Gold Council** | Central-bank gold reserves | Public XLSX, manual | Quarterly; download once, refresh quarterly |

### Notes

- **exchangerate.host went paid in 2024** — the headline-grabbing change broke many free pipelines. As of May 2026 a free tier exists again ([pricing page](https://exchangerate.host/pricing)) but limits are unclear and it requires a key. **Frankfurter is the cleaner replacement**: same ECB reference rates, no key, no rate limit, 1999+ history.
- **DXY:** FRED `DTWEXBGS` is the broad trade-weighted USD; ICE DXY (the headline futures index) is licensed. For directional thesis work the FRED series is fine; if a hypothesis depends on DXY-vs-gold correlations specifically tied to the futures index, use Yahoo `DX-Y.NYB`.

---

## 5. Recommended Free Stack

### Daily Refresh Job — Capacity Sketch

| Asset class | Calls/day target | Bytes/call | Daily payload | Free-tier headroom |
|---|---|---|---|---|
| US equities (5k symbols, yfinance batch) | ~50 batch calls of 100 symbols | ~10 KB/call | ~500 KB | 50 calls vs Yahoo's soft ~2k/hr — comfortable |
| Commodities (10 series, FRED) | 10 | ~5 KB | ~50 KB | 10 vs 120/min — trivial |
| Crypto top-50 (CoinGecko `/coins/markets`) | 1 paginated call | ~30 KB | ~30 KB | 1 vs 30/min — trivial |
| FX (Frankfurter latest+historical) | 1 | ~5 KB | ~5 KB | unlimited — trivial |
| Macro (FRED, ~40 series) | 40 | ~5 KB | ~200 KB | 40 vs 120/min — trivial |
| **Total** | **~100 API calls/day** | — | **~800 KB** | Fits comfortably |

A weekly fundamentals pass against SEC EDGAR adds maybe 5,000 calls (1 per ticker), at 10 req/sec budget that's ~10 minutes wall-clock; entirely feasible.

### Final Recommendation Table

| Asset class | Primary vendor | Free-tier limit | Backup vendor | Library | Endpoint | Notes |
|---|---|---|---|---|---|---|
| **US equities EOD** | Yahoo via `yfinance` | ~2k/hr soft IP cap | Stooq (bulk CSV) for cold start; Tiingo (50 sym/hr) for resilience | Python: [`yfinance`](https://github.com/ranaroussi/yfinance); Go: [`wnjoon/go-yfinance`](https://github.com/wnjoon/go-yfinance) or [`markcheno/go-quote`](https://github.com/markcheno/go-quote) | `yf.download(tickers, period="1d")` batch | ToS gray for commercial; OK for paper-only research |
| **US equity fundamentals** | SEC EDGAR | 10 req/sec, User-Agent required | Tiingo fundamentals (paid) | Python: [`sec-edgar-api`](https://pypi.org/project/sec-edgar-api/); Go: stdlib `net/http` | `data.sec.gov/api/xbrl/companyconcept/CIK{...}/us-gaap/{tag}.json` | Set `User-Agent: agent-wolf research kai@example.com` |
| **Commodity spot/benchmarks** | FRED | 120 req/min | Stooq, World Bank Pink Sheet | Python: [`fredapi`](https://github.com/mortada/fredapi); Go: any REST client | `api.stlouisfed.org/fred/series/observations?series_id=DCOILWTICO` | Series IDs: `DCOILWTICO`, `DCOILBRENTEU`, `DHHNGSP`, `GOLDPMGBD228NLBM`, `PCOPPUSDM` |
| **Commodity front-month futures** | yfinance (`CL=F`, `GC=F`, `NG=F`, `HG=F`, `ZC=F`, `ZW=F`, `ZS=F`) | shared with equities | Stooq | same as equities | `yf.download("CL=F GC=F", period="1d")` | Continuous-front-month, no roll adjustment |
| **Energy fundamentals** | EIA Opendata | Free key, generous | n/a | Python: [`EIA-python`](https://github.com/mra1385/EIA-python) or stdlib | `api.eia.gov/v2/petroleum/...` | Inventories, production, refinery util |
| **Crypto majors EOD** | CoinGecko Demo | 30 req/min, 10k/mo | Binance public klines, CryptoCompare | Python: [`pycoingecko`](https://github.com/man-c/pycoingecko); Go: [`superoo7/go-gecko`](https://github.com/superoo7/go-gecko) | `api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=50` | Demo key from CoinGecko dashboard |
| **Crypto exchange-fidelity OHLC** | Binance public | 2400 weight/min/IP, no auth | Kraken CSV ZIP, Coinbase Exchange | Go: [`adshao/go-binance`](https://github.com/adshao/go-binance); Python: [`python-binance`](https://github.com/sammchardy/python-binance) | `api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000` | No key, no rate-limit headache for daily candles |
| **Crypto fundamentals/on-chain** | Messari free | 20 req/min | CryptoCompare | Python: [`messari`](https://pypi.org/project/messari/) | `data.messari.io/api/v1/assets/{slug}/metrics` | Free tier covers basic supply/issuance |
| **FX (G10 + EM majors)** | Frankfurter | unlimited, no key | exchangerate.host (free plan), ECB SDW | stdlib HTTP — no library needed | `api.frankfurter.dev/v1/{date}?from=USD&to=EUR,JPY,...` | ECB reference rates, daily back to 1999 |
| **Rates / yields** | FRED | 120 req/min | Treasury Direct | `fredapi` | `DGS3MO`, `DGS2`, `DGS10`, `DGS30`, `DFF`, `T10Y2Y` | |
| **Inflation (CPI/PCE)** | FRED | 120 req/min | BLS API | `fredapi` | `CPIAUCSL`, `PCEPI`, `CPILFESL`, `PCEPILFE` | Monthly, releases mid-month |
| **Central bank gold reserves** | FRED + WGC quarterly XLSX | 120 req/min FRED | IMF SDMX | stdlib HTTP | WGC: `gold.org/goldhub/data/monthly-central-bank-statistics` (download) | Quarterly cadence is fine for thesis tracking |
| **Chinese FX reserves** | FRED `TRESEGCNM052N` | 120 req/min | SAFE manual scrape | `fredapi` | `series_id=TRESEGCNM052N` | Monthly |
| **DXY** | yfinance `DX-Y.NYB` | shared with equities | FRED `DTWEXBGS` (broad USD) | yfinance / fredapi | — | Choose ICE DXY for traders' perspective; broad USD for macro evidence |

### Architecture sketch

- Go backend hosts the orchestrator, SQLite/Parquet store, and most REST clients (FRED, Frankfurter, EIA, EDGAR, Binance — all clean REST in Go).
- **Python sidecar** runs `yfinance` only — a small worker that exposes a `/refresh` endpoint and writes Parquet partitions the Go side reads. yfinance's bot-evasion + crumb-rotation logic isn't worth re-porting; the official discussion thread on a Go port ([yfinance #2647](https://github.com/ranaroussi/yfinance/discussions/2647)) confirms maintainers prefer users keep Python-side. `wnjoon/go-yfinance` exists with TLS fingerprint spoofing if a Go-only constraint becomes binding.
- One scheduled job at ~22:30 ET (post-US close) does the equity refresh, then commodity, then macro, then crypto cuts at 00:00 UTC. Each step is independent and idempotent.

---

## 6. Upgrade Path (when a hypothesis "looks promising")

| Asset class | Free → Paid step | Why upgrade |
|---|---|---|
| US equities | **Tiingo Power $19.99/mo** or **Polygon Stocks Starter $29/mo** ([Polygon pricing](https://polygon.io/pricing)) | Removes ToS ambiguity, gets 5–30 yrs adjusted, real fundamentals, official corporate-actions feed |
| US equities (institutional) | Polygon Advanced ~$200/mo | Full options chain, real-time, full historical 20+ yrs |
| Commodities (deeper futures + roll-adjusted) | **Nasdaq Data Link continuous contracts**, or **Barchart OnDemand** ($50–$150/mo) | Proper CME-licensed continuous contracts, splice methodologies documented |
| Commodity fundamentals | **CME DataMine** (per-dataset), **S&P Global Platts** for energy | Once an energy-supply thesis matters more than price, fundamental detail justifies the cost |
| Crypto | **CoinGecko Analyst $129/mo** or **CryptoCompare Professional $79/mo** | Removes the 10k/mo cap, unlocks deep historical |
| Crypto on-chain | **Glassnode Advanced $39/mo**, **Coin Metrics Network Pro** | When a thesis depends on supply, holder cohorts, or exchange flows |
| Macro/FX | FRED + Frankfurter rarely justify upgrade. If we add EM/Asia we go to **CEIC** or **Haver** (enterprise, $$$). | Only justified post-product-market-fit |
| Fundamentals | Tiingo fundamentals add-on $29/mo, or **Financial Modeling Prep $19/mo** | When EDGAR XBRL parsing gets old |

The natural first upgrade for agent-wolf is almost certainly **Polygon Stocks Starter ($29/mo)** the first time a US-equity thesis is promising enough to warrant spend, plus **CoinGecko Analyst ($129/mo)** if/when the crypto leg gets serious. Total realistic v1.5 budget: **$160/mo** to remove every gray-zone dependency.

---

## Honest Gotchas Checklist

- **Yahoo ToS ambiguity** is the single biggest legal risk in the recommended stack. Mitigation: paper-only phase OK; transition to Tiingo/Polygon before publishing or trading.
- **Stooq** is a Polish portal with no SLA and no support. CSV format has changed historically; build the parser defensively.
- **Splits & dividends**: yfinance with `auto_adjust=True` returns adjusted closes; raw closes are also available via `actions=True`. Stooq adjusts close but not OHLC. Tiingo adjusts everything cleanly. Document which adjustment philosophy each pipeline uses.
- **Weekend / holiday gaps:** US equities skip weekends + ~10 holidays/yr. Crypto trades 24/7. FX (Frankfurter) skips weekends + TARGET2 holidays. The schema must be timestamp-keyed, not row-index-keyed.
- **Currency:** FRED gold = USD/oz London; LBMA also USD; copper FRED = USD/MT not USD/lb (LME convention). Document units.
- **CoinGecko Demo key** is rate-limited globally per key, so don't share between environments — give each env its own key.
- **EDGAR User-Agent:** SEC blocks requests without a descriptive `User-Agent` containing contact info. Format: `User-Agent: AgentWolf research-team contact@example.com`.
- **Binance geo-block:** US IPs may be redirected to Binance.US. If running from US infra, use `data.binance.com` or rotate via a non-US egress for the historical pull, then incremental from the US side has been observed to work.
- **Continuous front-month futures:** yfinance `=F` is not roll-adjusted; if a hypothesis depends on returns continuity (e.g. carry strategies), pull individual contracts and splice yourself or upgrade to Nasdaq Data Link continuous.
- **FRED revisions:** macro series get revised retroactively. Always store `realtime_start`/`realtime_end` if hypothesis evidence depends on what was known at the time (use ALFRED endpoints for vintage data).

---

## Sources

- [yfinance PyPI](https://pypi.org/project/yfinance/)
- [yfinance GitHub](https://github.com/ranaroussi/yfinance)
- [Yahoo Developer ToS](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html)
- [Alpha Vantage premium / free limits](https://www.alphavantage.co/premium/)
- [Alpha Vantage IEX Cloud migration analysis](https://www.alphavantage.co/iexcloud_shutdown_analysis_and_migration/)
- [Tiingo pricing](https://www.tiingo.com/about/pricing)
- [Polygon pricing](https://polygon.io/pricing)
- [EODHD pricing](https://eodhd.com/pricing)
- [Twelve Data pricing](https://twelvedata.com/pricing)
- [Marketstack pricing](https://marketstack.com/pricing)
- [Stooq historical data](https://stooq.com/db/h/)
- [SEC EDGAR API guide](https://tldrfiling.com/blog/sec-edgar-api-guide/)
- [SEC EDGAR rate limits](https://tldrfiling.com/blog/sec-edgar-api-rate-limits-best-practices)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [FRED API docs](https://fred.stlouisfed.org/docs/api/fred/)
- [FRED Terms of Use](https://fred.stlouisfed.org/docs/api/terms_of_use.html)
- [fredapi (Python)](https://github.com/mortada/fredapi)
- [EIA Opendata](https://www.eia.gov/opendata/)
- [World Bank Pink Sheet](https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/world-bank-commodities-price-data-the-pink-sheet)
- [LBMA precious metal prices](https://www.lbma.org.uk/prices-and-data/precious-metal-prices)
- [Nasdaq Data Link (Quandl successor)](https://data.nasdaq.com/)
- [CoinGecko public-plan rate limit](https://support.coingecko.com/hc/en-us/articles/4538771776153-What-is-the-rate-limit-for-CoinGecko-API-public-plan)
- [CoinMarketCap pricing](https://coinmarketcap.com/api/pricing/)
- [Binance API limits](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits)
- [Kraken historical OHLCVT](https://support.kraken.com/articles/360047124832-downloadable-historical-market-data-time-and-sales-)
- [CryptoCompare API guide](https://www.cryptocompare.com/coins/guides/how-to-use-our-api/)
- [Messari API](https://messari.io/api)
- [Frankfurter docs](https://frankfurter.dev/)
- [exchangerate.host pricing](https://exchangerate.host/pricing)
- [wnjoon/go-yfinance](https://github.com/wnjoon/go-yfinance)
- [markcheno/go-quote](https://github.com/markcheno/go-quote)
- [pycoingecko](https://github.com/man-c/pycoingecko)
- [adshao/go-binance](https://github.com/adshao/go-binance)
