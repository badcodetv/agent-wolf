# 06 — Storage Architecture for hypothesis-bot

> Scope: pick durable stores for the three data shapes (hypothesis records, embedded evidence, time-series + scores) under a hard $0/mo v1 ceiling, with a clean paid upgrade path. Mirror Platinum's stack where it doesn't hurt.
>
> **2026-05-09 update (KISS pass).** Originally recommended Firebase Auth as the one Firebase piece worth keeping; we've since dropped Firebase entirely and consolidated on **Supabase Auth** (same vendor as Postgres). See [`08-supabase-auth-multiuser.md`](08-supabase-auth-multiuser.md) and [`09-kiss-architecture-decision.md`](09-kiss-architecture-decision.md). The data-store recommendation in this brief is unchanged; only the auth row in the final table moves from Firebase to Supabase.

---

## 1. Hypothesis records — Firestore vs. Postgres vs. hybrid

The three candidates differ less in capability than in *how many distinct backends end up in the stack*.

### 1.1 Firestore (what the user named)

Firebase Firestore's free Spark tier in 2026 still publishes the same envelope it has had since 2019: 50k document reads/day, 20k writes/day, 20k deletes/day, 1 GiB stored, 10 GiB/mo egress. For 3–5 users editing thousands of hypothesis records that ceiling is fine; the per-user activity model is exactly what Spark was sized for. Firebase Auth (Google sign-in) is genuinely free at small scale — billing is via the Identity Platform upgrade once you exceed 50k MAUs, which we will not.

The drawbacks are real and structural, not pricing-related:

- **Not relational.** The collaborator/sharing model (`hypothesis_collaborators`) is awkward — you do it as denormalized lists of UIDs on each hypothesis doc and accept that listing "all hypotheses I can see" is either a `array-contains` query or a fan-out write.
- **No JOINs.** A hypothesis row references evidence and a score series. Firestore can't join those; the API has to do it client-side.
- **Separate from vectors and time-series.** Firestore got vector search in late 2024 (single-field KNN, no hybrid search, no SQL), but it's not in the same league as pgvector + tsvector for our use case.
- **Lock-in.** Firestore data export → Postgres is annoying enough that most teams just don't.

### 1.2 Managed Postgres (mirrors Platinum)

Free Postgres tiers worth knowing in 2026:

| Provider | Free ceiling (2026) | pgvector | TimescaleDB ext | Notes |
|---|---|---|---|---|
| **Neon** | 0.5 GiB storage, 191 compute-hours/mo (auto-suspend), branching | yes (pgvector ≥ 0.8) | **no** (extension not allowed on free; same on paid) | Best DX, branch-per-PR is excellent |
| **Supabase** | 0.5 GiB DB, 5 GB egress, project pauses after 1 wk inactivity | yes | yes (extension shipped, including `timescaledb` core; toolkit also enabled) | Bundles auth + storage + edge functions; pause-on-idle bites |
| **Railway** | $5/mo trial credit, then paid; no permanent free | yes | yes | Easiest deploy; not actually $0 |
| **Fly.io Postgres** | Free allowance gone (deprecated late 2024); managed Postgres now paid (~$2–3/mo for shared 256 MB) | yes | yes | Cheapest "real" tier, but not zero |
| **Aiven** | 1-month free trial, then paid | yes | yes (Timescale officially supported) | Best for paid step; not v1 |
| **Render** | Free Postgres expires after 90 days, then deletes | yes | no | Avoid — data deletion is disqualifying |
| **Timescale Cloud** | 30-day trial then paid (~$25/mo entry) | yes | yes (it's the vendor) | The eventual paid step |
| **ElephantSQL** | **Shut down Jan 2025**. Skip. | — | — | — |

Two viable $0 options: **Neon** (best DX, no Timescale) and **Supabase** (Timescale extension + pgvector + Auth in one box, but project auto-pauses on idle which makes scheduled batch jobs flaky unless you ping it).

### 1.3 Hybrid (auth provider only, Postgres for data)

Auth provider choice is decoupled from data store choice. Either Supabase Auth or Firebase Auth would work over a Postgres data store; the verifier is the only difference. After the KISS pass, **Supabase Auth wins on lock-in arithmetic** because we already chose Supabase Postgres — collapsing Auth into the same vendor saves an SDK, a console, and an onboarding flow without locking us in further than the data layer already does.

### 1.4 Verdict for §1

**Postgres-everywhere wins.** Hypothesis records, evidence vectors, and market time-series all want the same engine, and SQL JOINs across them (e.g. "show me the latest 10 evidence items for hypothesis X joined with its current score") fall out for free. Use **Supabase** for Postgres + Timescale + pgvector + Auth in one box, or **Neon** for better DX (no Timescale, no Auth — would force a separate auth vendor back into the stack).

---

## 2. Vector search — pgvector vs. dedicated vector DB

### 2.1 Free-tier matrix (2026)

| Service | Free ceiling | Hybrid (BM25 + vector) | Self-host option |
|---|---|---|---|
| **pgvector on Postgres** | whatever the host allows | yes (combine with `tsvector` + `ts_rank_cd`) | trivially |
| **Qdrant Cloud** | 1 GB cluster, 1 node, single region (unchanged 2026) | yes (built-in BM25 since 1.10) | yes (Apache 2.0) |
| **Pinecone Starter** | 2M vectors / 1 project / 5 indexes (free), no pod concept anymore (serverless GA 2024) | yes (sparse-dense hybrid) | no |
| **Weaviate Cloud** | 14-day sandbox, then paid; no permanent free | yes | yes (BSD-3) |
| **Chroma** | OSS only, self-host | weak hybrid, getting better | yes |
| **Turbopuffer** | $0 below ~10M ops/mo (object-storage-backed; pay-per-query) | yes | no |
| **Vespa Cloud** | Perpetual free trial 14 days, then paid | yes (best-in-class) | yes |

Pinecone and Qdrant Cloud both fit our volume comfortably. But every dedicated vector DB introduces a second consistency boundary: when you write a hypothesis row in Postgres and an evidence vector in Pinecone, you now have a two-phase-commit problem you didn't have before, and "delete user X's data" becomes a cross-system transaction.

### 2.2 Why pgvector specifically

- **HNSW is first-class.** pgvector 0.7 (2024) added HNSW; 0.8 (late 2024) added iterative index scans and binary quantization; 0.9 (mid-2025) tightened recall on filtered queries. By 2026 the gap to dedicated DBs at our scale (hundreds of thousands to a few million vectors) is performance-irrelevant.
- **Hybrid search is one query.** `SELECT … ORDER BY (0.5 * (1 - (embedding <=> $1)) + 0.5 * ts_rank_cd(tsv, plainto_tsquery($2)))` — both signals in the same engine, with the same `WHERE` filters (`hypothesis_id = ?`, `created_at > now() - interval '30 days'`).
- **Same migration system.** New evidence types are a Platinum-style `000NNN_*.go` migration; no separate schema tool.
- **Backups and PITR are unified.** One `pg_dump` covers everything.
- **Costs co-amortize.** The 0.5 GiB free Postgres covers thousands of evidence rows with embeddings (1536-d float32 ≈ 6 KB each, so ~80k vectors fits in 0.5 GiB *with* their text). Halving vector dims (text-embedding-3-small with `dimensions=512`) doubles that.

### 2.3 When to graduate

If evidence rows pass ~10M and HNSW build time on Neon's compute starts to bite, the migration target is either Timescale Cloud (which carries pgvector) at ~$25/mo, or Qdrant Cloud paid (~$25/mo for 4 GB) reading from a Postgres write-through. Both are mechanical.

**Verdict for §2: pgvector. Don't add a second store until you've measured.**

---

## 3. Time-series of market data + per-tick scores

### 3.1 Sizing math

- Universe: 5,000 tickers (generous; realistic is 200–1,000).
- Frequency: daily close (Polygon free tier = 5/min, cap at end-of-day).
- Retention: 10 years.
- Rows: 5,000 × 252 trading days × 10 ≈ **12.6M rows**.
- Per-row cost: ticker (varchar 16) + ts (8) + 5 numerics (8 each) ≈ 64 B + index overhead ≈ 120 B/row → **~1.5 GiB**.

For per-hypothesis scores: a few thousand hypotheses × daily for years ≈ low millions of rows, trivial.

### 3.2 Candidates

- **Plain Postgres with `(ticker, ts)` primary key + BRIN on `ts`.** Append-only daily inserts, range scans on `WHERE ticker = ? AND ts BETWEEN ? AND ?`. At 12M rows this is genuinely fine — Postgres laughs at 12M rows of timeseries with the right index. **No Timescale needed at v1.**
- **TimescaleDB extension (OSS).** Hypertables auto-partition by time; chunk pruning, continuous aggregates, compression (10×) — all free as the OSS extension. Worth it once retention crosses ~100M rows or when you want continuous aggregates ("rolling 30-day vol per ticker") computed automatically. **Provider availability:** Supabase yes, Aiven yes, Timescale Cloud yes (vendor), Neon **no** (extension not available, confirmed 2026), RDS no (extension blocked), Heroku no.
- **InfluxDB Cloud Serverless free.** 5 GB writes/30 days, 5 GB queries/30 days. Workable but adds a second store and Flux/InfluxQL — not worth it.
- **DuckDB on Parquet in object storage.** Beautiful for batch analytics, painful for the "append-one-day-and-also-keep-querying-it" pattern hypothesis-bot needs. Don't.
- **ClickHouse Cloud free.** No permanent free tier (30-day trial, then ~$66/mo entry). Skip for v1.

### 3.3 Verdict

**Plain Postgres tables with BRIN/B-tree indexes for v1.** Provider choice hinges on whether you want Timescale optionality:

- If you stick with **Neon** (recommended for DX), you commit to "we will refactor to a hypertable on a different host if/when we exceed Neon's headroom." That's fine for 12M rows.
- If you pick **Supabase**, enable the `timescaledb` extension on day one and create the score and market tables as hypertables — the conversion-later cost is zero, and you get continuous aggregates immediately.

Either way, **don't introduce InfluxDB or ClickHouse**. The data fits in Postgres for years.

---

## 4. Concrete schema sketches

Migration files live at `/home/kai/projects/kai/agent-wolf/hypothesis-bot/goapi/pkg/store/migrations/000NNN_description.go`, registered in `all.go` exactly as Platinum does it. Below is the SQL each migration would emit via `m.ExecSQL(ctx, …)`.

```sql
-- 000001_initial_schema.go
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector
-- (Supabase only) CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supabase_uid    UUID UNIQUE NOT NULL,           -- matches auth.users.id in Supabase
    email           VARCHAR(320) UNIQUE NOT NULL,
    display_name    VARCHAR(255) DEFAULT '',
    role            VARCHAR(16) NOT NULL DEFAULT 'viewer', -- operator|editor|viewer
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL
);
-- No claude_oauth_token column: the operator's CLAUDE_CODE_OAUTH_TOKEN
-- lives as an env var on the goworker container, not in the DB.

CREATE TABLE IF NOT EXISTS hypotheses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    spec            JSONB NOT NULL DEFAULT '{}',  -- full LLM-generated spec
    cadence         VARCHAR(32) NOT NULL DEFAULT 'daily', -- daily|hourly|weekly|cron:*
    status          VARCHAR(32) NOT NULL DEFAULT 'active',
    -- Beta-Binomial state (see docs/research/02-time-series-methods.md §1.1)
    prior_alpha     DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    prior_beta      DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    posterior_alpha DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    posterior_beta  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_owner   ON hypotheses(owner_id);
CREATE INDEX IF NOT EXISTS idx_hypotheses_status  ON hypotheses(status);
CREATE INDEX IF NOT EXISTS idx_hypotheses_spec_gin ON hypotheses USING GIN (spec jsonb_path_ops);

CREATE TABLE IF NOT EXISTS hypothesis_collaborators (
    hypothesis_id   UUID NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(32) NOT NULL DEFAULT 'viewer', -- viewer|editor
    created_at      BIGINT NOT NULL,
    PRIMARY KEY (hypothesis_id, user_id)
);
```

```sql
-- 000002_evidence_items.go
CREATE TABLE IF NOT EXISTS evidence_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hypothesis_id   UUID NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
    source          VARCHAR(64) NOT NULL,    -- 'twitter'|'rss'|'sec'|'reddit'|...
    source_id       VARCHAR(255) NOT NULL,   -- upstream id, for dedupe
    url             TEXT,
    author          VARCHAR(255),
    text            TEXT NOT NULL,
    text_tsv        TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    embedding       VECTOR(512),             -- text-embedding-3-small @ 512 dims
    metadata        JSONB NOT NULL DEFAULT '{}',
    captured_at     BIGINT NOT NULL,
    created_at      BIGINT NOT NULL,
    UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_hypothesis ON evidence_items(hypothesis_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_tsv        ON evidence_items USING GIN (text_tsv);
CREATE INDEX IF NOT EXISTS idx_evidence_hnsw       ON evidence_items
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

```sql
-- 000003_market_observations.go
CREATE TABLE IF NOT EXISTS market_observations (
    ticker      VARCHAR(16) NOT NULL,
    ts          DATE NOT NULL,
    open        NUMERIC(18,6),
    high        NUMERIC(18,6),
    low         NUMERIC(18,6),
    close       NUMERIC(18,6) NOT NULL,
    volume      BIGINT,
    source      VARCHAR(32) NOT NULL DEFAULT 'polygon',
    PRIMARY KEY (ticker, ts)
);
CREATE INDEX IF NOT EXISTS idx_market_ts_brin ON market_observations USING BRIN (ts);
-- Supabase / Timescale only:
-- SELECT create_hypertable('market_observations', 'ts', if_not_exists => TRUE,
--                          chunk_time_interval => INTERVAL '90 days');
```

```sql
-- 000004_hypothesis_scores.go
CREATE TABLE IF NOT EXISTS hypothesis_scores (
    hypothesis_id   UUID NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
    ts              TIMESTAMPTZ NOT NULL,
    posterior_mean  DOUBLE PRECISION NOT NULL,        -- E[θ]
    posterior_alpha DOUBLE PRECISION NOT NULL,
    posterior_beta  DOUBLE PRECISION NOT NULL,
    evidence_count  INTEGER NOT NULL DEFAULT 0,
    likelihood      DOUBLE PRECISION,                 -- this-batch log-likelihood
    notes           JSONB NOT NULL DEFAULT '{}',      -- per-channel breakdown
    PRIMARY KEY (hypothesis_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_scores_ts_brin ON hypothesis_scores USING BRIN (ts);
```

The `all.go` registry mirrors Platinum exactly:

```go
// hypothesis-bot/goapi/pkg/store/migrations/all.go
package migrations

var All = []Migration{
    {Name: "000001_initial_schema",      Up: InitialSchema},
    {Name: "000002_evidence_items",      Up: EvidenceItems},
    {Name: "000003_market_observations", Up: MarketObservations},
    {Name: "000004_hypothesis_scores",   Up: HypothesisScores},
}
```

---

## 5. Embedding model — what to pay for $0

| Model | Dim | Cost (2026) | Notes |
|---|---|---|---|
| **OpenAI text-embedding-3-small** | 512–1536 (configurable) | $0.02 / 1M tokens | 10k rows × 500 tok/row = 5M tok ≈ $0.10/mo. Effectively free. Best quality/$ at this volume. |
| **Voyage AI voyage-3-lite** | 512 | 200M tokens free, then $0.02/1M | Strong on retrieval benchmarks; free trial covers MVP entirely. |
| **Cohere embed-v4.0** | 256–1536 (Matryoshka) | Free trial limited; production paid | Multilingual, hybrid-search optimized. Trial only. |
| **sentence-transformers (`all-MiniLM-L6-v2` or `bge-small-en-v1.5`)** | 384 | $0 | Runs in-process / Python sidecar; ~50ms CPU latency. Quality gap is real for nuanced finance text but acceptable for v1. |
| **Local nomic-embed-text via Ollama** | 768 | $0 | Best free local; needs ~1 GB RAM, runs alongside the Go API container. |

**Pick: OpenAI text-embedding-3-small at 512 dims.** Cost at our likely volume (10k embeddings/month ≈ 5M tokens) is $0.10/mo — under the noise floor. 512 dims (instead of default 1536) cuts pgvector storage and HNSW build cost by 3× with negligible recall loss, per OpenAI's own published Matryoshka eval. If "$0 hard" is required, fall back to **bge-small-en-v1.5** in a small Python sidecar called from Go over HTTP.

---

## 6. Final recommended stack

**Verdict (one sentence):** Use **Supabase Postgres** (free tier) as the single store for hypothesis records, pgvector evidence, and Timescale-hypertabled market data; use **Supabase Auth** for Google sign-in (same vendor); embed with **OpenAI text-embedding-3-small @ 512 dims**.

| Component | Service (v1, $0) | Free-tier ceiling | Paid step |
|---|---|---|---|
| Hypothesis records (relational) | Supabase Postgres | 0.5 GiB, pauses after 1 wk idle | Supabase Pro $25/mo or Timescale Cloud $25/mo |
| Vector search (evidence) | Same Postgres + pgvector + HNSW | shares the 0.5 GiB | same paid step; pgvector scales to ~10M rows on a 4 GB DB |
| Time-series (market + scores) | Same Postgres, hypertable on Supabase | shares the 0.5 GiB | same paid step; hypertables compress 10× when needed |
| Full-text search (hybrid) | Postgres `tsvector` + GIN | included | included |
| Auth (Google sign-in) | Supabase Auth (same vendor as DB) | 50k MAU | Supabase Pro $25/mo |
| Embeddings | OpenAI text-embedding-3-small | n/a (~$0.10/mo at our volume) | linear by tokens |
| Job queue | River (Postgres-backed, like Platinum) | shares the DB | shares the DB |
| Object storage (raw scrapes, prompts) | Supabase Storage | 1 GiB | Pro tier |

**Honest divergence note.** The user guessed Firebase. The data-layer answer is clearly Postgres: vector + time-series both want SQL and both want to live next to the relational hypothesis records, so Postgres is the only data store that stays *one* store across all three shapes. Adopting Firestore would force two backends (Firestore + a vector DB + likely a third for time-series), each with its own auth, its own backups, and a cross-system "delete user X" problem. The auth question is independent: Supabase Auth gives us "Google login fast" without adding a second vendor (the original recommendation kept Firebase Auth alongside Supabase Postgres; the KISS pass collapsed both into Supabase).

If Supabase's auto-pause becomes a problem for scheduled cadences (River jobs running at 4am EST hitting a paused DB), switch to **Neon** (no auto-pause within the compute-hour budget) and accept "no Timescale" — the 12M-row sizing math says plain Postgres is sufficient for v1 anyway.

---

## 7. Supabase Auth coexistence (note)

Supabase Auth (GoTrue) issues HS256-signed JWTs against the project's `SUPABASE_JWT_SECRET`. The Go backend verifies them with `golang-jwt/jwt v5` (~30 LOC, no external SDK; see [`08`](08-supabase-auth-multiuser.md)), extracts the `sub` (Supabase UID) and `email`, and upserts a row in the Postgres `users` table. From there the JWT-bearing middleware looks identical to Platinum's `requireAuthMiddleware` — substitute the Supabase HS256 verifier for Platinum's per-user HMAC verifier and the rest of the route stack is unchanged. Custom claims (our `app_metadata.role`) are server-managed via Supabase's Admin REST API.

---

## What to copy from Platinum

- **Migrations system.** Same `goapi/pkg/store/migrations/000NNN_description.go` + `all.go` registry, same `Migrator` interface, same "never reorder, never modify" rule, same run-on-startup behavior. The four schema migrations above are drop-in.
- **DB driver pattern.** **pgx v5** for raw queries and the River queue (`riverpgxv5`), **GORM v1.30** for the simple CRUD on `hypotheses` / `users`, **goqu/v9** for dynamic query building on `evidence_items` (hybrid-search rank expressions). Exact same versions as Platinum's `go.mod` so the team's muscle memory transfers.
- **Server struct.** Mirror `PlatinumAPIServer` with a `HypothesisBotAPIServer` holding `store.Store`, `riverClient`, `supabaseVerifier`, `openaiClient` — handlers reach them via the receiver, no globals.
