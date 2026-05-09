# Signal Sources for an Autonomous Crypto Trading Agent (May 2026)

A practical survey for `agent-wolf` — pure-research phase, small experimental capital, multi-day horizons, Hyperliquid + Solana DEX focus. Pricing and access verified May 2026.

## 1. Social Signals

### Twitter / X — the messy giant
The official X API moved to **pay-per-use** as of February 2026: $0.005 per post read, $0.01 per profile, capped at 2M reads/month unless you go Enterprise ($42K+/mo). **There is no new Basic/Pro tier and no free tier for new developers** — only legacy subscribers retain $100/mo Basic and $5K/mo Pro. New devs get a one-time $10 credit voucher. Cost-effective for a small agent only if you carefully select KOLs and pre-filter.

**Scraping** (twscrape, snscrape) is on life support. snscrape has 200+ open issues and breaks roughly every 2-4 weeks; twscrape is more actively maintained but requires authenticated X accounts (which get banned). Expect 10-15 hrs/month maintenance. Not viable for production.

**GROK API is the dark horse for X data.** xAI gives **$150/month free credits** through its data-sharing program (you let them train on your prompts) plus $25 signup credit — the most generous free tier in the AI space. Grok 4.1 Fast is $0.20/$0.50 per M tokens; the platform exposes an **X Search tool at $2.50-$5 per 1,000 calls**. This is effectively the cheapest legitimate path to X sentiment in 2026 — let Grok do the search and summarization rather than buying raw X API access.

**LunarCrush** aggregates social data across X/Reddit/YouTube into Galaxy Score and AltRank metrics, exposes an MCP server, and is purpose-built for crypto sentiment — better signal-to-noise than rolling your own. **Santiment** combines social with on-chain (transaction volume, dev activity) and is the more "fundamental" sentiment vendor. Both have paid tiers; useful when you want pre-cooked sentiment rather than raw firehose.

### Farcaster — easier and cheaper
**Neynar** (which acquired the Farcaster protocol in January 2026) offers a **free tier with 200K compute units**, then $9/$49/$249 per month. Public Hub APIs are also free. Crypto-native user base, less spam than X, but smaller signal volume — use it as a complement, not primary.

### Telegram
Telethon and Pyrogram still work for monitoring channels via the user API (not Bot API) — needs a phone-verified user account. Alpha-channel reality is brutal: most paid signal channels are pump-and-dump or pay-to-play. Treat Telegram as **input for sentiment/narrative, not direct trade signals**. Top signal aggregators monitor 1,000+ channels covering 5M subscribers — useful as a distillation layer if you don't want to roll your own.

### Reddit & Discord
Reddit API still has a usable free tier (60 req/min) and r/CryptoCurrency / r/wallstreetbets sentiment is occasionally a contrarian indicator. Discord webhook scraping is technically ToS-violating; alpha-group reality is similar to Telegram (mostly noise, occasional real edge with established communities).

## 2. News / Fundamental

- **CryptoPanic** — free tier ~50-200 req/hr, paid plans for production. Aggregates ~150 sources, sentiment-tagged. Good base layer.
- **Decrypt / The Block / CoinDesk RSS** — free, low effort, lagging but reliable.
- **Polymarket** — Gamma API is **free, public, no auth**. Crypto-relevant markets (Fed decisions, ETF approvals, SEC actions, rate cuts) update faster than news media. **$7B/month volume in Feb 2026** — this is now a real macro signal source, not a toy.
- **FRED** — free official Fed data API; macro context (rates, DXY, M2).
- **SEC EDGAR / Fed calendar** — both free, crucial for catalyst awareness.

## 3. On-Chain Analytics

- **Dune Analytics** — Free tier now includes **2,500 monthly credits + API access by default** (as of late 2025). Pay-as-you-go at $5 per 100 extra credits. Tiers go to Plus ($349/mo). Best for custom queries against indexed chain data.
- **Nansen** — Pro is **$49/mo annual / $69/mo monthly**. Pay-per-call API: **$0.01/call basic, $0.05/call advanced** (smart-money flows). Smart-money tracking on ~10K curated wallets — high-quality signal but the cost adds up at scale.
- **Arkham** — entity-tagged data on 800M+ addresses; API access via "Ultra" engine. Whale Alert dev tier $49/mo.
- **Lookonchain** — **free**, hand-curated whale event narratives on X. High value-per-cost; treat as a feed to consume rather than an API.
- **Helius** (Solana) — **free tier 1M credits/mo + 10 RPC req/s**. Paid: $49 / $499 / $999. Webhooks make it trivial to react to wallet activity. Best free Solana RPC.
- **Etherscan / Alchemy** — standard EVM coverage, generous free tiers.

## 4. Market Data

- **CoinGecko** — Demo free: 30 calls/min, 10K calls/month. Paid from $129/mo.
- **CoinMarketCap** — Basic free: 10K credits/mo, 30 req/min.
- **Hyperliquid** — `https://api.hyperliquid.xyz/info` is **public, free, no auth**. Funding history, mark price, OI, liquidations all available. Funding rates on Hyperliquid are exceptional signals (paid hourly, predictable interest component) — funding extremes correlate with reversal risk. Use this directly.
- **DexScreener** — **free, no API key, 300 req/min on pair endpoints, 60 req/min on token profiles**. Cross-chain. Default for memecoin pair discovery and lightweight price.
- **Birdeye** — Solana/EVM token data; tiered API (Lite/Starter/Standard/Premium/Business) with WebSocket on higher tiers (500-2000 connections). Better than DexScreener for active Solana trading.
- **Pyth / Chainlink** — on-chain oracles, free to read.

## 5. AI-Aggregated Search

- **Anthropic native web search** (built into Claude API) — best ergonomics inside the agent loop, no separate key, results cached automatically. Default choice for the agent-wolf loop given Max subscription model.
- **Grok with X Search tool** — $2.50-5 per 1K calls, plus $150/mo free credits. **The cheapest way to get X sentiment in 2026.**
- **Perplexity Sonar** — $1-5 per 1K requests + token costs. Good for grounded research summaries.
- **Brave Search API** — **$5 per 1K requests** flat across web/news/images, simpler pricing. Solid neutral fallback.

## Comparison Table

| Source | Free? | Paid entry | S/N (1-5) | Difficulty (1-5) |
|---|---|---|---|---|
| X official API | No (new) | $0.005/read, pay-per-use | 4 | 4 |
| Grok API + X Search | $150/mo credits | ~$3-5/1K calls | 4 | 2 |
| X scrapers (twscrape) | Yes | — | 3 | 5 |
| LunarCrush | Limited | Paid tiers | 4 | 2 |
| Farcaster (Neynar) | 200K units/mo | $9/mo | 3 | 1 |
| Telegram (telethon) | Yes | — | 2 | 3 |
| Reddit | Yes | — | 2 | 1 |
| CryptoPanic | Yes (50-200/hr) | Paid | 3 | 1 |
| Polymarket | **Free public** | — | 5 | 2 |
| FRED | **Free** | — | 4 | 1 |
| Dune Analytics | 2,500 credits/mo | $5/100 credits | 4 | 3 |
| Nansen | No | $49/mo + per-call | 5 | 2 |
| Lookonchain | **Free (X feed)** | — | 5 | 2 |
| Helius | 1M credits/mo | $49/mo | 5 | 2 |
| CoinGecko | 10K calls/mo | $129/mo | 4 | 1 |
| Hyperliquid info API | **Free public** | — | 5 | 1 |
| DexScreener | **Free public** | — | 4 | 1 |
| Birdeye | Limited | Tiered | 4 | 2 |
| Anthropic web search | Bundled | Token cost | 4 | 1 |
| Perplexity Sonar | No | $1-5/1K | 4 | 1 |
| Brave Search | No | $5/1K | 3 | 1 |

## Free vs Paid Breakdown

**All-free starter stack ($0/mo):** Hyperliquid info API + DexScreener + Polymarket + Lookonchain (X feed via RSS bridges) + Helius free + Dune free tier + CryptoPanic free + FRED + Reddit + Anthropic native web search (cost flows through Claude tokens).

**Cheapest meaningful paid additions (<$100/mo total):** Nansen Pro ($49/mo annual) for smart-money flows + Neynar $9/mo for Farcaster + Grok API on the $150/mo data-sharing credits (effectively free) for X coverage.

## Recommended Minimum Viable Stack (5 sources that pull weight)

For a small-capital, multi-day-horizon experimental agent, the best signal-per-dollar mix is:

1. **Hyperliquid info API (free)** — funding rates, OI delta, liquidation cascades. Native to your trading venue, leading indicator for unwinds. **Non-negotiable.**
2. **Lookonchain feed + Nansen Pro ($49/mo)** — smart-money is the only social-flavored signal with consistent edge. Lookonchain is the free narrative layer; Nansen is the queryable backbone.
3. **Grok API with X Search ($0 net via data-sharing credits)** — cheapest legitimate way to ingest X sentiment in 2026. Bypasses the X API pricing trap.
4. **Polymarket Gamma API (free)** — macro/event probabilities (Fed, ETF, regulatory) reprice faster than news. Genuine leading indicator at multi-day horizons.
5. **DexScreener + Helius free tier (free)** — covers Solana memecoin discovery and EVM pair scanning without hitting a single paywall.

Total recurring cost: **~$49/mo**. Add Dune pay-as-you-go (~$10-30/mo) when you start running custom queries. Skip LunarCrush and direct X API until you have a model that can demonstrably extract alpha from raw social — premature investment otherwise.

The pattern: **free public APIs for market data, one paid on-chain intelligence subscription, and use Grok/Anthropic LLMs as the search/sentiment layer rather than buying raw social firehoses.**

## Sources
- [X (Twitter) API Pricing 2026](https://postproxy.dev/blog/x-api-pricing-2026/)
- [X API Pricing Update April 2026](https://devcommunity.x.com/t/x-api-pricing-update-owned-reads-now-0-001-other-changes-effective-april-20-2026/263025)
- [xAI Grok API Pricing 2026](https://www.aifreeapi.com/en/posts/xai-grok-api-pricing)
- [Grok API Pricing Guide May 2026](https://costgoat.com/pricing/grok-api)
- [Neynar Pricing](https://neynar.com/pricing)
- [Neynar acquires Farcaster](https://www.coindesk.com/business/2026/01/21/farcaster-founders-step-back-as-neynar-acquires-struggling-crypto-social-app)
- [LunarCrush API](https://lunarcrush.com/about/api)
- [Santiment API](https://api.santiment.net/)
- [How to Scrape Twitter in 2026](https://scrapfly.io/blog/posts/how-to-scrape-twitter)
- [twscrape GitHub](https://github.com/vladkens/twscrape)
- [Dune Analytics Pricing](https://dune.com/pricing)
- [Nansen API Pay-Per-Call](https://docs.nansen.ai/about/credits-and-pricing-guide)
- [Nansen Pay-Per-Use Launch](https://www.crowdfundinsider.com/2026/04/274494-blockchain-analytics-firm-nansen-enhances-onchain-data-access-with-pay-per-call-model/)
- [CryptoPanic API Plans](https://cryptopanic.com/developers/api/plans)
- [Helius Pricing](https://www.helius.dev/pricing)
- [Hyperliquid Funding Docs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)
- [Hyperliquid Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
- [Polymarket API Architecture](https://medium.com/@gwrx2005/the-polymarket-api-architecture-endpoints-and-use-cases-f1d88fa6c1bf)
- [Polymarket as Macro Sentiment](https://www.buildix.trade/blog/polymarket-macro-sentiment-crypto-trading)
- [Perplexity Pricing 2026](https://www.finout.io/blog/perplexity-pricing-in-2026)
- [Brave Search API for AI](https://brave.com/blog/most-powerful-search-api-for-ai/)
- [CoinGecko API Pricing](https://www.coingecko.com/en/api/pricing)
- [Best Free Crypto API 2026 (CMC)](https://coinmarketcap.com/academy/article/best-free-crypto-api-in-2026-free-tier-comparison)
- [Arkham API](https://intel.arkm.com/api)
- [Arkham + Lookonchain Tracking](https://phemex.com/news/article/arkham-and-lookonchain-lead-in-crypto-tracking-and-analysis-56504)
- [Birdeye API Pricing Docs](https://docs.birdeye.so/docs/pricing)
- [DexScreener API Reference](https://docs.dexscreener.com/api/reference)
