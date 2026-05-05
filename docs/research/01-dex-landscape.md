# DEX Landscape for an Autonomous Trading Agent

*Date: 2026-05-05. Caveat: this space moves fast; treat any specific number (fees, leverage, asset count) as current-as-of-now and reverify before code commits.*

## 1. Hyperliquid (Primary Target)

**API & SDKs.** Hyperliquid offers a REST `info` endpoint, a REST `exchange` (signing) endpoint, and WebSocket streams. A premium gRPC stream via third-party RPCs (Chainstack, HypeRPC, Dwellir) is the lowest-latency option. Official SDKs:
- Python: https://github.com/hyperliquid-dex/hyperliquid-python-sdk (1.5k stars, MIT, last updated April 2026, v0.23.0, Python 3.9–3.13). PyPI: `hyperliquid-python-sdk`.
- Rust: https://github.com/hyperliquid-dex/hyperliquid-rust-sdk (official).
- TypeScript: no official SDK, but several active community ones — https://github.com/nktkas/hyperliquid and https://github.com/nomeida/hyperliquid are the most prominent.
- CCXT also has a fork: https://github.com/ccxt/hyperliquid-python.

**Latency.** Sub-second order finality via HyperBFT consensus; throughput cited around ~100k orders/sec. Native WebSocket gives sub-second updates with occasional spikes; gRPC streams are ~50 ms tighter. Co-location is not really a thing — your gain is RPC choice, not geography.

**Fees.** Perps: 0.015% maker / 0.045% taker at base tier, scaling to 0.000% maker / 0.024% taker at top tier. Spot: 0.040% / 0.070% base. Up to 40% additional discount for staking HYPE. Tier 4+ makers are free. Gas is effectively zero — the L1 absorbs it.

**Auth model.** EVM-style ECDSA signatures (secp256k1), so any EVM wallet (`eth_account`, ethers.js) works. The crucial agent feature is the **API wallet / agent wallet** primitive: the master account approves a separate keypair (`approveAgent` action) that can sign trade actions but **cannot withdraw funds**. Limits: 1 unnamed + up to 3 named per master, plus 2 named per subaccount. When querying, you must use the master/subaccount address, not the agent address. This is exactly the security model agent-wolf wants. Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets.

**Coverage.** ~100+ perp markets, leverage 3x–40x depending on asset (margin tiers compress at scale), USDC-margined linear contracts, oracle in USDT. Spot markets exist alongside. HIP-3 builder-deployed perps and HIP-4 outcome markets expand the universe.

**Rate limits.** Address-based: 10,000 request initial buffer, then 1 request per 1 USDC traded cumulative. When throttled: 1 req / 10s. Cancels get a higher cap. Reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits.

**KYC / geo.** Zero KYC — wallet-only. Restricted via IP geofencing: **US, Ontario, Cuba, Iran, Myanmar, North Korea, Syria**, and sanctioned regions. This is a real concern for a US-based operator; the user's legal posture matters here.

## 2. Jupiter (Solana Spot Aggregator)

**APIs.** Jupiter is the routing layer for ~80% of Solana swap volume. Three relevant products:
- **Ultra Swap API**: RPC-less, gasless, auto-slippage, in-house "Jupiter Beam" landing engine. Best default for agent swaps.
- **V6 Swap API** (legacy/lower-level): https://hub.jup.ag/docs/apis/swap-api.
- **Limit Order** and **DCA** APIs for scheduled / triggered execution.

**SDKs.** `@jup-ag/core` (TypeScript), https://github.com/jup-ag/jupiter-swap-api-client (Rust), and a community Python SDK https://github.com/0xTaoDev/jupiter-python-sdk that wraps swap, limit, DCA, and price endpoints. New developer platform launched 2026-04-06 with revised pricing and rate limits — check current quota tiers.

**Signing.** Standard Solana — `solana-py` / `@solana/web3.js`, ed25519 keypair, JSON-RPC submission. No agent-wallet primitive equivalent to Hyperliquid; you typically run a dedicated hot wallet with limited capital.

## 3. Comparison Table — Other Perps DEXs

| DEX | Chain | Perps / Spot | SDK Quality | Fee Model | Agent-friendly (1–5) |
|---|---|---|---|---|---|
| **Hyperliquid** | Hyperliquid L1 | Perps + Spot | Official Py/Rust, strong TS community | 0.015%/0.045% perps, scales to 0%/0.024% | **5** — agent wallets, gas-free, deep API |
| **dYdX v4** | dYdX Chain (Cosmos SDK) | Perps only | Official Py, TS, Rust quick-starts; Hummingbot/Nautilus support | Maker rebates / taker tiers; no gas, validator-based | **4** — solid API, Cosmos signing adds friction |
| **GMX v2** | Arbitrum, Avalanche, Botanix, MegaETH | Perps + Spot swaps | Official `@gmx-io/sdk` TS (Node ≥18). https://github.com/gmx-io/gmx-ai (agent skills repo, AI-explicit) | Open/close fees + funding; pays L2 gas | **3** — usable but on-chain TX flow + L2 gas |
| **Drift** | Solana | Perps + Spot | TS + Python + HTTP gateway; keeper bot tutorials | Maker/taker tiers; Solana priority fees | **4** — designed for keeper/JIT bots, Solana speed |
| **Vertex** | Arbitrum (+ others) | Perps + Spot + money market | Python (https://vertex-protocol.github.io/vertex-python-sdk/) + TS; cross-margin | Hybrid orderbook, low fees | **3** — solid SDK but smaller mindshare; up to 10x |

dYdX v4 GitHub: https://github.com/dydxprotocol/v4-chain. GMX SDK docs: https://docs.gmx.io/docs/sdk/overview/. Drift v2 protocol: https://github.com/drift-labs/protocol-v2.

## 4. Memecoin Venues

This is a different ecosystem — interaction is overwhelmingly "**sniper bot**" tooling, not "agent" tooling.

- **Raydium**: Solana AMM (CPMM + CLMM). Programmatic via `@raydium-io/raydium-sdk` (TS) or community Rust SDKs like https://github.com/0xfnzero/sol-trade-sdk that bundle Raydium + Pump + Bonk + Meteora for low-latency sniping. Direct on-chain interaction — no centralized API.
- **pump.fun**: Bonding-curve launchpad. No official trading API; bots watch Solana logs / Geyser / Helius / Jito for new mints and submit pre-built TXs in one slot. Open-source reference: https://github.com/chainstacklabs/pumpfun-bonkfun-bot (no third-party deps), https://github.com/carson2222/pumpfun-bot.
- **BullX / BullX Neo**: closed-source web + Telegram bot, **invite-only**, 1% fee per trade, no public programmatic API. Useful as a manual UX layer, not as an agent backend.
- **Photon**: closed-source web UI, fastest for manual sniping; no public API. Same story — UI tool, not an SDK target.

**Sniper bot vs agent.** Sniper tooling optimizes one thing: latency from `mint` → `buy` (millisecond regime, often Jito-bundled, often co-located). agent-wolf, with multi-day hypothesis horizons, lives a different tier — it should treat memecoin venues as places to *execute* hypothesis-driven trades on-chain via Jupiter/Raydium SDKs, not compete with snipers on launch. If/when you want sniper behaviour, fork an existing pump.fun bot rather than building one.

## 5. Recommendation: MVP Starting Set

**Start with Hyperliquid + Jupiter. Two adapters, narrowly scoped.**

**Hyperliquid first, primary venue.** Reasons:
1. **Agent wallet primitive is purpose-built for this use case** — non-withdrawable signing key is the right security boundary for an autonomous agent.
2. Single mature official Python SDK; no need to assemble a stack.
3. No gas, sub-second latency, deep perp + spot coverage in one venue.
4. Fee economics among the best in the space.
5. Caveat: **US/Ontario geofence is a hard problem**. If the operator is US-based, this is a legal/operational blocker that needs user-level resolution before code matters.

**Jupiter second, for spot/memecoin exposure.** Reasons:
1. Single API gets you ~80% of Solana DEX liquidity including Raydium, Meteora, Orca.
2. Ultra API is gasless + RPC-less — operationally far simpler than direct Raydium SDK usage.
3. Limit + DCA APIs let the agent express multi-day hypotheses without holding open orders client-side.
4. Memecoin venues become reachable as Jupiter routes, without a separate adapter per launchpad.

**Defer**: dYdX v4 (Cosmos signing tax, perps-only, narrower asset set), GMX v2 (good but you'd duplicate Hyperliquid's perp coverage with worse latency), Drift/Vertex (good fallbacks if Solana perps become a thesis target). Defer all closed-source memecoin frontends (BullX, Photon) — they aren't agent-targets.

**Architecture note.** Build venue-agnostic position/order/risk abstractions from day one; the two adapters share enough surface (place/cancel/poll/positions) that this pays back fast when you add a third.

## Gaps & Caveats

- Specific Hyperliquid leverage caps and asset list change frequently — pull from `meta` endpoint at runtime, don't hardcode.
- Jupiter's new Developer Platform (April 2026) changed pricing/rate limits; verify current free-tier quotas before committing to architecture decisions.
- HIP-3/HIP-4 builder-deployed perps and outcome markets are recent — venue-deployer trust is a new risk surface.
- Authoritative numbers for Hyperliquid maximum simultaneous open orders per address — verify against docs.
- "Agent-friendly" ratings reflect SDK ergonomics + auth model + cost, not legal risk; the latter is jurisdiction-dependent.
- US accessibility status for all venues should be re-verified by the operator; this brief reflects publicly-stated policies, not enforcement reality.

## Sources
- [Hyperliquid Python SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk)
- [Hyperliquid Rust SDK](https://github.com/hyperliquid-dex/hyperliquid-rust-sdk)
- [Hyperliquid GitHub org](https://github.com/hyperliquid-dex)
- [Hyperliquid API docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)
- [Hyperliquid rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)
- [Hyperliquid agent wallets / nonces](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)
- [Hyperliquid fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)
- [Hyperliquid latency optimization](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/optimizing-latency)
- [Hyperliquid restricted countries (Datawallet)](https://www.datawallet.com/crypto/hyperliquid-supported-and-restricted-countries)
- [Hyperliquid US availability](https://hyperliquidguide.com/privacy/hyperliquid-us-availability)
- [nktkas/hyperliquid TS SDK](https://github.com/nktkas/hyperliquid)
- [nomeida/hyperliquid TS SDK](https://github.com/nomeida/hyperliquid)
- [Jupiter Swap API docs](https://dev.jup.ag/docs/ultra)
- [Jupiter V6 Swap API](https://hub.jup.ag/docs/apis/swap-api)
- [Jupiter Rust client](https://github.com/jup-ag/jupiter-swap-api-client)
- [Jupiter Python SDK (community)](https://github.com/0xTaoDev/jupiter-python-sdk)
- [QuickNode Jupiter trading bot guide](https://www.quicknode.com/guides/solana-development/3rd-party-integrations/jupiter-api-trading-bot)
- [dYdX docs](https://docs.dydx.xyz/)
- [dYdX v4 chain GitHub](https://github.com/dydxprotocol/v4-chain)
- [GMX SDK overview](https://docs.gmx.io/docs/sdk/overview/)
- [GMX AI agent skills repo](https://github.com/gmx-io/gmx-ai)
- [Drift Protocol docs](https://docs.drift.trade/)
- [Drift protocol-v2 GitHub](https://github.com/drift-labs/protocol-v2)
- [Vertex Python SDK](https://vertex-protocol.github.io/vertex-python-sdk/api-reference.html)
- [Chainstack pump.fun/bonk bot](https://github.com/chainstacklabs/pumpfun-bonkfun-bot)
- [carson2222/pumpfun-bot](https://github.com/carson2222/pumpfun-bot)
- [0xfnzero/sol-trade-sdk (Raydium/Pump/Bonk Rust)](https://github.com/0xfnzero/sol-trade-sdk)
- [Photon-vs-Trojan-vs-BullX comparison](https://cointrenches.io/photon-vs-trojan-vs-bullx-which-solana-bot-is-best/)
- [Top pump.fun sniper bots (QuickNode)](https://www.quicknode.com/builders-guide/best/top-9-pump-fun-sniper-bots)
- [Hyperliquid REST/WS/gRPC comparison](https://coincodecap.com/hyperliquid-api-rest-vs-websocket-vs-grpc-compared)
