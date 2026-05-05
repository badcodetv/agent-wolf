# Open-Source Autonomous Trading Agents: Prior-Art Brief

Survey of existing projects for `agent-wolf` (LLM-driven autonomous trader, Hyperliquid + Solana DEX focus). Goal: identify what to borrow, reference, or skip. Date: 2026-05-05.

---

## 1. Traditional Algo-Trading Frameworks

These are mature, battle-tested execution engines. None are LLM-native, but several are clean enough to use as a backbone we wrap with an LLM "brain."

| Project | License | Lang | DEX support | Verdict |
|---|---|---|---|---|
| [Freqtrade](https://github.com/freqtrade/freqtrade) | GPL-3.0 | Python | CEX-only via CCXT (~30 exchanges, no DEX) | **Skip.** GPL is viral; no DEX support; CEX-centric. |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Apache-2.0 | Python + Cython | CEX + DEX (Uniswap, PancakeSwap) via Gateway middleware; 140+ venues | **Reference.** Apache-2.0 is friendly. The Gateway DEX abstraction layer is genuinely worth studying for our DEX execution code. Not LLM-native — too monolithic to extend with an agent loop cheaply. |
| [Jesse](https://github.com/jesse-ai/jesse) | MIT | Python | Spot/futures/DEX claimed; primarily CEX in practice | **Reference.** MIT, clean strategy abstraction, has "JesseGPT" feature. Good backtesting harness to copy patterns from. |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | LGPL-3.0 | Rust core + Python | CEX + DEX (DeFi feature flags: pool sync, block sync) | **Reference.** Highest quality engineering of the bunch (Rust core, deterministic event-driven). LGPL is workable (dynamic linking is fine). Probably overkill for our experimental scale — but a goldmine for backtest/replay design. |
| [QuantConnect Lean](https://github.com/QuantConnect/Lean) | Apache-2.0 | C# + Python | Crypto via Coinbase/Binance/Bitfinex/Kraken; dYdX DEX brokerage exists | **Skip.** C#-first, equities-flavored, no Hyperliquid, not idiomatic for our Claude Code stack. |

**Takeaway:** No traditional framework is a great backbone for us — they assume CEX execution and human-written strategies. Hummingbot's Gateway and Nautilus's event model are worth reading; nothing to fork wholesale.

---

## 2. LLM-Driven Trading Agents (most relevant)

### [TradingAgents](https://github.com/TauricResearch/TradingAgents) — Tauric Research
- **License:** Apache-2.0 | **Language:** Python (LangGraph)
- **Summary:** Multi-agent LLM framework mirroring a real trading firm: fundamental analyst, sentiment expert, technical analyst, trader, risk team, portfolio manager, with a "research debate" phase.
- **v0.2.4** (Apr 2026) added structured-output decision agents, LangGraph checkpoint resume, persistent decision log with reflections, supports Claude/GPT-5/Gemini/DeepSeek/Qwen/Grok.
- **Verdict: BORROW HEAVILY.** This is the closest prior art to our multi-agent design. The debate loop, role separation, and reflection pattern are directly applicable. Equities-only out of the box but the agent topology is the actual asset. Paper: [arXiv 2412.20138](https://arxiv.org/abs/2412.20138).

### [elizaOS / Eliza](https://github.com/elizaOS/eliza)
- **License:** MIT | **Language:** TypeScript
- **Summary:** Crypto-native agent framework (formerly ai16z). Has [plugin-solana](https://github.com/elizaos-plugins/plugin-solana) (Jupiter swaps, position sizing, token validation, order book), plugin-evm, and a long-tail plugin registry.
- **Verdict: REFERENCE.** Best-in-class for crypto plumbing (Solana/Jupiter/EVM connectors are MIT and copy-able). But it's TS-first and oriented toward "personality agents that tweet" rather than disciplined trading. Lift the connectors, skip the agent runtime.

### [AI Trading Agent on Hyperliquid (Gajesh2007)](https://github.com/Gajesh2007/ai-trading-agent)
- **License:** Check repo (likely MIT) | **Language:** Python
- **Summary:** Single-loop LLM agent that reads Hyperliquid market data, makes a decision, places orders with TP/SL.
- **Verdict: REFERENCE** (study, don't fork). Validates our exact pattern; small enough to read in an afternoon.

### [Hyper-Alpha-Arena (HammerGPT)](https://github.com/HammerGPT/Hyper-Alpha-Arena)
- **License:** Verify | **Language:** Python
- **Summary:** Arena where GPT/Claude/DeepSeek autonomously trade Hyperliquid + Binance Futures and compete.
- **Verdict: REFERENCE.** Useful for the multi-model evaluation harness pattern.

### [LLM_trader (qrak)](https://github.com/qrak/LLM_trader)
- **License:** Verify | **Language:** Python
- **Summary:** LLM-powered trading framework with vision-AI chart analysis, memory-augmented reasoning, live monitoring dashboard.
- **Verdict: REFERENCE.** Vision-on-charts is a pattern we should evaluate for hypothesis formation.

### [Olas trader (valory-xyz)](https://github.com/valory-xyz/trader)
- **License:** Apache-2.0 | **Language:** Python
- **Summary:** Production autonomous agent for prediction markets (Omen/Polymarket). Runs as on-chain Safe-multisig service.
- **Verdict: REFERENCE.** Different domain (prediction markets, not perps), but the **service architecture** — autonomous agent represented on-chain by a multisig, with attestation/governance — is the most mature prior art for "fully autonomous, accountable" loops. Worth one read.

### [Virtuals Protocol](https://github.com/Virtual-Protocol)
- **Summary:** Tokenized AI agents on Base. [virtuals-python](https://github.com/Virtual-Protocol/virtuals-python) SDK; [openclaw-acp](https://github.com/Virtual-Protocol/openclaw-acp) CLI for agent commerce.
- **Verdict: SKIP** for the trading core. The platform is more about tokenizing agents than the trading loop itself. Could be relevant later if we want a tokenization story; not for v1.

### [TradingGoose](https://github.com/TradingGoose/TradingGoose.github.io)
- **Summary:** Multi-agent LLM trading framework, equities-focused, Alpaca-integrated. Apparently inspired by/forked from TradingAgents.
- **Verdict: SKIP.** TradingAgents is the upstream — go there.

### [AI-Trader (HKUDS)](https://github.com/HKUDS/AI-Trader)
- **License:** Verify | **Language:** Python
- **Summary:** Academic project: "100% Fully-Automated Agent-Native Trading."
- **Verdict: REFERENCE.** Worth a skim for architectural ideas; HKUDS has produced solid academic systems.

### Goose / Open Interpreter / smolagents
- No first-party trading agents found. These are general-purpose code-execution agent frameworks. **Skip** as scaffolding — Claude Code (our chosen runtime) already covers this niche better.

### Notable cautionary tale
The [PromptMink supply-chain attack](https://www.reversinglabs.com/blog/claude-promptmink-malware-crypto) (Feb 2026) compromised an open-source autonomous crypto trading project (`openpaw-graveyard`) via a Claude-coauthored commit that pulled in a malicious npm dep. **Implication for us:** lock dependencies, pin hashes, and treat any "borrowed" trading repo as untrusted until audited.

---

## 3. Hyperliquid Ecosystem

| Project | License | Verdict |
|---|---|---|
| [hyperliquid-python-sdk](https://github.com/hyperliquid-dex/hyperliquid-python-sdk) (official) | MIT | **Borrow.** This is the canonical Python client. Use directly. |
| [hyperliquid-mcp (edkdev)](https://github.com/edkdev/hyperliquid-mcp) | Verify | **Borrow / Reference.** MCP server wrapping the SDK — drops straight into Claude Code as a tool layer. Strongly worth evaluating. |
| [chainstacklabs/hyperliquid-trading-bot](https://github.com/chainstacklabs/hyperliquid-trading-bot) | Verify | Reference. Multi-signal (Z-score, spike, trend) Python bot. |
| [Passivbot](https://github.com/enarjord/passivbot) | Verify | Reference. Mature grid/DCA bot in Python+Rust, supports Hyperliquid + 6 CEXs. Not LLM-driven. |
| [Jackhuang166/hyberliquid-arbitrage](https://github.com/Jackhuang166/hyberliquid-arbitrage) | Verify | Skip. Bybit↔Hyperliquid arb in Rust — narrow scope. |
| [StreetJammer/hyperliquid-vault-analyzer](https://github.com/StreetJammer/hyperliquid-vault-analyzer) | Verify | Reference. Vault portfolio optimization + risk analysis — useful for the "watch HLP and competing vaults" research signal. |

**HLP / public vaults:** The official HLP strategy is **proprietary, not open-source**. Don't expect to learn HLP's edge from code. **HIP grants:** searches surfaced HIP-1/HIP-2/HIP-3 (token standards / permissionless markets), but no specific AI-agent grant program found. Closest analog: [Based](https://www.theblock.co/post/390809/hyperliquid-web3-based-funding-pantera) — VC-funded ($11.5M Series A from Pantera, Q1 2026) — not a grant, not open-source.

---

## 4. Academic / Research Projects

| Paper / Repo | Architecture | Runnable? |
|---|---|---|
| [FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | Domain-tuned financial LLMs (LoRA on base models) + 4-layer stack: data sources → engineering → LLMs → applications | Yes — models on HF. **Reference**, more sentiment/news analyst than trader. |
| [FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) | 4-layer agent platform: Financial AI Agents → LLM Algorithms → LLMOps/DataOps → Foundation Models | Yes. **Reference.** Apache-2.0, AI4Finance Foundation. Same lineage as FinGPT. [Paper](https://arxiv.org/abs/2405.14767). |
| [FinMem](https://github.com/pipiku915/FinMem-LLM-StockTrading) | Profiling + Layered Memory + Decision modules. Memory tiers mimic human cognition (working/short/long). | Yes. **Borrow heavily** — the layered-memory module is directly applicable to our multi-day horizon. [Paper](https://arxiv.org/abs/2311.13743). |
| [FinAgent](https://personal.ntu.edu.sg/boan/papers/KDD24_FinAgent.pdf) | Multimodal foundation agent with tool augmentation, layered memory, technical-indicator integration | Code release status unclear; **reference** the architecture from the paper. |
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) | Multi-agent debate (already covered above) | Yes, Apache-2.0. **Borrow heavily.** |
| [FINCON (NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/file/f7ae4fe91d96f50abc2211f09b6a7e49-Paper-Conference.pdf) | Manager–analyst hierarchy + conceptual verbal RL | Code partially available. **Reference** for the verbal-RL/reflection loop. |

The academic cluster converges on three patterns we should adopt: **(a) layered memory** (FinMem), **(b) multi-role debate** (TradingAgents/FINCON), **(c) reflection-on-outcome** (TradingAgents v0.2.4, FINCON). All MIT/Apache compatible.

---

## 5. Final Ranked Shortlist — Top 5 to Actually Study

1. **[TradingAgents](https://github.com/TauricResearch/TradingAgents)** (Apache-2.0) — closest match to our multi-agent design; steal the role topology, debate loop, and reflection mechanism. Equities domain but architecture is portable. Active (v0.2.4 Apr 2026), 61k stars.
2. **[hyperliquid-python-sdk](https://github.com/hyperliquid-dex/hyperliquid-python-sdk) + [hyperliquid-mcp](https://github.com/edkdev/hyperliquid-mcp)** (MIT) — non-negotiable execution layer. The MCP wrapper plugs directly into Claude Code as a tool.
3. **[FinMem](https://github.com/pipiku915/FinMem-LLM-StockTrading)** — borrow the layered-memory module wholesale; it's the only prior art designed for *multi-day-horizon* LLM trading, which matches our hypothesis horizon exactly.
4. **[elizaOS plugin-solana](https://github.com/elizaos-plugins/plugin-solana)** (MIT) — lift the Jupiter swap, token validation, and position sizing code; ignore the rest of Eliza.
5. **[Olas trader](https://github.com/valory-xyz/trader)** (Apache-2.0) — read the autonomous-service-as-multisig pattern. Even if we don't go on-chain governance, the bounded-autonomy + attestation patterns are the most mature in the space.

**Honorable mentions worth one read each:** Hummingbot Gateway (DEX abstraction), NautilusTrader (event model), AI Trading Agent on Hyperliquid (single-file reference impl), FinRobot (4-layer separation of concerns).

**Hard skips:** Freqtrade (GPL + CEX-only), QuantConnect Lean (wrong stack), Virtuals Protocol (tokenization theater), TradingGoose (use upstream), ChatGPT-Agent / generic agent frameworks (Claude Code already covers).

---

## Sources
- [Freqtrade](https://github.com/freqtrade/freqtrade)
- [Hummingbot GitHub](https://github.com/hummingbot/hummingbot) / [hummingbot.org](https://hummingbot.org/)
- [Jesse](https://github.com/jesse-ai/jesse)
- [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) / [site](https://nautilustrader.io/)
- [QuantConnect Lean](https://github.com/QuantConnect/Lean)
- [TradingAgents](https://github.com/TauricResearch/TradingAgents) / [paper](https://arxiv.org/abs/2412.20138)
- [elizaOS](https://github.com/elizaOS/eliza) / [plugin-solana](https://github.com/elizaos-plugins/plugin-solana) / [plugin-solana-agent-kit](https://github.com/elizaos-plugins/plugin-solana-agent-kit)
- [AI Trading Agent on Hyperliquid](https://github.com/Gajesh2007/ai-trading-agent)
- [Hyper-Alpha-Arena](https://github.com/HammerGPT/Hyper-Alpha-Arena)
- [LLM_trader](https://github.com/qrak/LLM_trader)
- [hyperliquid-mcp](https://github.com/edkdev/hyperliquid-mcp)
- [Olas trader](https://github.com/valory-xyz/trader) / [trader-quickstart](https://github.com/valory-xyz/trader-quickstart)
- [Virtuals Protocol GitHub](https://github.com/Virtual-Protocol)
- [hyperliquid-python-sdk](https://github.com/hyperliquid-dex/hyperliquid-python-sdk)
- [Passivbot](https://github.com/enarjord/passivbot)
- [chainstacklabs/hyperliquid-trading-bot](https://github.com/chainstacklabs/hyperliquid-trading-bot)
- [hyperliquid-vault-analyzer](https://github.com/StreetJammer/hyperliquid-vault-analyzer)
- [FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) / [paper](https://arxiv.org/abs/2306.06031)
- [FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) / [paper](https://arxiv.org/abs/2405.14767)
- [FinMem](https://github.com/pipiku915/FinMem-LLM-StockTrading) / [paper](https://arxiv.org/abs/2311.13743)
- [FinAgent (KDD24)](https://personal.ntu.edu.sg/boan/papers/KDD24_FinAgent.pdf)
- [FINCON (NeurIPS24)](https://proceedings.neurips.cc/paper_files/paper/2024/file/f7ae4fe91d96f50abc2211f09b6a7e49-Paper-Conference.pdf)
- [AI-Trader (HKUDS)](https://github.com/HKUDS/AI-Trader)
- [TradingGoose](https://github.com/TradingGoose/TradingGoose.github.io)
- [PromptMink writeup (ReversingLabs)](https://www.reversinglabs.com/blog/claude-promptmink-malware-crypto) — security cautionary tale
- [Based / Pantera Series A](https://www.theblock.co/post/390809/hyperliquid-web3-based-funding-pantera)
- [Hyperliquid HLP vault docs](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/protocol-vaults)
- [Nexus Erebus (Solana agent framework)](https://github.com/MaliosDark/nexus-erebus-agent-token-framework)
- [Soltrade](https://github.com/noahtheprogrammer/soltrade)
- [Solana Foundation awesome-solana-ai](https://github.com/solana-foundation/awesome-solana-ai)
