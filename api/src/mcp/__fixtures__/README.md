# MCP fixtures

## `spec-candidate-thirteen-errors.txt` — RECORDED 2026-09-07

The verbatim content of memory `39e4357b-b931-48c0-be85-f9bce4e6b633`, a
`hypothesis-spec-candidate` deposited by a **real interview** on the live
local stack (session `143b02e97a93…`, hypothesis `4f40b1f7`), pulled
straight out of Postgres:

```sh
docker exec agent-bob-postgres-1 psql -U agentbob -d agentbob -tAc \
  "select content from memories where id='39e4357b-b931-48c0-be85-f9bce4e6b633';" \
  > api/src/mcp/__fixtures__/spec-candidate-thirteen-errors.txt
```

**Why it is worth keeping.** That interview was good — good questions, a
sharp thesis, a sensible scoreboard, and a report template that validated
first time. Then it deposited this, with **thirteen schema errors**, and the
user's Go Live button never appeared. Nothing told the user why, and nothing
told the model either.

The errors were not carelessness. `prompts/interviewer.md` described the
spec in PROSE — "each naming a metric, a statistic, a comparison and a
threshold" — and the real fields are `stat` and `op`, with unknown keys
rejected at every level (V7). It also never mentioned `unit`, `id`,
`sustained_days` or `meaning`. The model followed the prompt exactly.

`specvalidate.test.ts` runs the real tool over these bytes and asserts it
names each of those, so the failure the tool exists to prevent is described
by an executing test rather than by this paragraph.

It also carries the second half of the story: the candidate was labelled
`name=gold-m2`, a slug invented from the thesis, because a session container
is given `SESSION_ID` and `SESSION_TOKEN` and **not its session's name** —
so the prompt's instruction to read the id off `hyp-<id>` was unfollowable.
The id now travels in the interview's first message (`seedMessage` in
`routes/hypotheses.ts`).

**Test-only.** `api`'s build is plain `tsc`, which does not copy `.txt` or
`.json` into `dist/` (see `marketdata/stooq-tickers.ts` for the time that
bit us), so nothing under this directory may be read by production code.
