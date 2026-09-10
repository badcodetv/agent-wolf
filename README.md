# Agent Wolf

A platform for stating trading hypotheses and having them deeply researched and continuously
validated. A user states a thesis, an interview sharpens it into a falsifiable spec, and a daily
job then researches and scores it until a human confirms or invalidates the thesis.

Agent Wolf is built on **[Agent Bob](../agent-bob)** as its runtime: Orange owns prompts,
sessions, schedules, memories and datasets; Wolf owns the page, the vocabulary and the user
allowlist. The full design — architecture, the trust model, the hypothesis lifecycle, and every
ticket that builds this repo — lives in agent-bob's
[`design/2026-08-20-agent-wolf.md`](../agent-bob/design/2026-08-20-agent-wolf.md). Read that
first; this README only covers running what's here.

> This repository previously held an earlier, architecturally different design
> ("hypothesis-bot": Go + Fiber + Supabase + TimescaleDB + River). That design was superseded on
> 2026-08-20 by the Agent-Bob-based plan above. Its research briefs are kept, not deleted, at
> [`docs/archive-2026-05-hypothesis-bot/`](docs/archive-2026-05-hypothesis-bot/).

## Layout

| Path | What |
| --- | --- |
| `api/` | Node + TypeScript API: hypothesis lifecycle, Orange client, market-data MCP server, evaluation poller. Express 5, vitest, zod, pino. |
| `web/` | React 18 + MUI 6 UI: hypothesis list/detail, scoreboard, the Orange chat embed. Vite + vitest. Its own components — imports nothing from agent-bob (`web/` there is a private, non-installable library; see the design doc's "Iframe-only UI reuse" decision). |
| `docker-compose.yml`, `.env.example` | The local topology — see below. |
| `docs/archive-2026-05-hypothesis-bot/` | The superseded first design, kept for its research briefs. |

## Running it locally

**Use agent-bob's `./stack wolf up`.** It is the supported development
workflow and it does every step below for you, in order, against the real
providers — real model, session image pulled from Artifact Registry, real Google
sign-in:

```sh
cd ../agent-bob
./stack publish-base dev     # once, if you never have: the base Wolf builds FROM
./stack wolf up              # BILLABLE. `./stack wolf up mock` is the free twin
# → Wolf http://localhost:8081   Orange http://localhost:8080
./stack wolf down
```

It publishes Wolf's session image, merges a `wolf` project into Orange's project
map (API key + allowed origins), starts both stacks, bootstraps the project, and
prints what it resolved. Local dev secrets are generated once into
agent-bob's gitignored `.stack-wolf-secrets.env`. Full description, including
the table of what still differs from a deployment and the **one manual step**
(registering `http://localhost:8081` as an authorized JavaScript origin on the
Google OAuth client): agent-bob's `README-stack.md` § "Agent Wolf: the joint
development workflow".

Two commands here are useful on their own:

```sh
./scripts/publish-image.sh          # build + push session-wolf (REGISTRY=… required)
./scripts/load-image-into-dind.sh   # the OFFLINE alternative: build into DinD
                                    #   instead of publishing. Only works when
                                    #   Orange was started in `local` image mode.
```

### By hand

**Order matters: bring Agent Bob up first.** Agent Wolf's compose file joins
Orange's compose network as `external` and shares Orange's `dind` container's
network namespace — both must already exist before `docker compose up` here can
succeed. This isn't a convenience choice: in the standalone stack `agentd` shares
DinD's network namespace, so nested session containers cannot resolve compose DNS
names and a `wolf-api` sitting on an ordinary compose network would be
unreachable from them. See `design/2026-08-20-agent-wolf.md` § "Local topology
and networking" for the full picture.

```sh
# 1. Agent Bob first — its compose network and dind container must exist
#    before Wolf's compose file can attach to them.
cd ../agent-bob
cp .env.example .env
docker compose up --build
# → http://localhost:8080

# 2. Agent Wolf second.
cd ../agent-wolf
cp .env.example .env
# WOLF_MCP_TOKEN is REQUIRED — wolf-api refuses to boot without it rather
# than serve its market-data MCP tools unauthenticated. Generate one into
# .env (never commit the value); the same value must reach session
# containers through Orange's MCP config.
echo "WOLF_MCP_TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" >> .env
# Three more are REQUIRED, and wolf-api names the missing one at boot:
#   WOLF_SESSION_SECRET  signs the wolf_session cookie (>= 32 chars)
#   WOLF_API_KEY         the "wolf" project's Orange API key (X-API-Key)
#   WOLF_ALLOWED_EMAILS  who may sign in; empty NEVER means everyone
echo "WOLF_SESSION_SECRET=$(openssl rand -base64 32)" >> .env
# WOLF_API_KEY must match the key Orange's project map names for the wolf
# project (`"api_key_env": "WOLF_API_KEY"`), and the allowlist is yours:
#   echo "WOLF_API_KEY=…"                     >> .env
#   echo "WOLF_ALLOWED_EMAILS=you@example.com" >> .env
docker compose up --build
# → http://localhost:8081 (WOLF_WEB_PORT)
```

`.env.example` documents every other variable, including the optional
`FRED_API_KEY` (macro series; without it Stooq still works and FRED calls
answer with a `misconfigured` error naming the variable).

## Development

```sh
yarn install --frozen-lockfile
yarn typecheck   # both packages
yarn test        # both packages

cd api && yarn typecheck && yarn test
cd web && yarn typecheck && yarn test
```

## Pinned technology

Named once in `design/2026-08-20-agent-wolf.md` § "Pinned technology choices" so later work
doesn't pick differently: Express 5, `@modelcontextprotocol/sdk` (HTTP transport), vitest,
`undici`'s `MockAgent` for HTTP mocking in tests, React 18.3.1 + MUI 6, Recharts, native `Date` +
explicit UTC helpers (no moment/dayjs), zod, and `pino` (JSON to stdout, never a credential or a
`download_url`).

## Shared error taxonomy

`api/src/errors.ts` defines `WolfError` and the seven `WolfErrorKind` values every route, client and
background job uses — see that file and the design doc's § "Shared error taxonomy". Don't invent
a second one.
