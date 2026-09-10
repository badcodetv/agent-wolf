# Hypothesis fixtures

Two kinds of file live here:

- `worked-spec.json` — W3's transcription of the plan's own worked spec example.
  Not a captured response; see W3.
- **Everything else** — Orange HTTP **response bodies captured verbatim** from a
  running build, for W5. Byte-for-byte what `agentd` wrote to the socket
  (compact JSON, one trailing newline). Nothing here was reformatted,
  hand-edited or hand-shaped; if a body looks odd, that is what Orange returns.

## The build they came from

| | |
| --- | --- |
| Repo | `agent-bob` (`github.com/badcodetv/agent-bob`) |
| Commit | **`af0e0cb1f4ed91fc9b00f73e8e51b413d6349eaf`** (`main`, "Wave-4 pre-flight: merge waves 1-3 to main, and two plan fixes") |
| O11 merged in it as | `53d9bcc` — "Merge O11 (carries O7): POST /agent/memories, and include_retracted" |
| Captured | **2026-08-21** |
| Binary | `go build -o agentd ./cmd/agentd` from that commit, run directly on the host |
| Store | `pgvector/pgvector:pg16`, a throwaway instance (tmpfs storage, port 5436), migrations `001`–`045` applied by `agentd` itself at boot |
| Model | **mock** — the boot log line `[agentd] ANTHROPIC_API_KEY unset → MOCK model proxy (set it for a real agent)` is the proof. No billable agent ran |
| Project | `wolf`, reached with a throwaway project API key (`X-API-Key`) generated for the capture and never written down anywhere |

`docker compose up` was **not** used (a house rule for this wave forbids it while
sibling worktrees are active); the same `agentd` binary was run against the
throwaway Postgres with `DOCKER_HOST` pointing at the host daemon. The routes
these bodies come from — `POST /agent/memories`, `GET /agent/memories`,
`GET /agent/sessions` — are the identical handlers the compose stack serves.

## How each row was written

- Every **trusted** row (empty provenance) was appended through the real
  `POST /agent/memories` route (O7) with the project API key, and Orange
  answered `201`. That route stamps provenance empty and refuses a body that
  tries to supply it — verified during the capture: a body carrying
  `"created_by_worker": ""` is rejected `400` with
  *"created_by_worker is stamped by the server from your credential and cannot
  be set by the caller …"*. So an empty-provenance row here could not have been
  faked by the request.
- Every row with **non-empty provenance** — the forged state rows and the
  hostile retractions — was written with `agentdb.Store.CreateMemory`, the same
  call the core MCP server's `memory_create` tool makes
  (`go/cmd/agentd/mcp_memory.go:322-328`), passing the same `CreatedByWorker` /
  `CreatedBySession` fields it fills from the calling session's actor. There is
  no HTTP path that can write those fields, by design: the only credential that
  stamps them is a session token minted inside a container. **The response
  bodies below are still Orange's own serialisation of those rows, read back
  over HTTP from the running build.**
- The sessions were created through the real `POST /agent/session` route and
  really provisioned containers from `agentkit-example:dev` (status `running`
  in the captured bodies). All six were deleted through
  `DELETE /agent/session/{id}` after capture.

## The files

### `board-all-trusted.json`
`GET /agent/memories?selector=kind%3Dhypothesis&latest_per=name&limit=100`
over three hypotheses whose newest row is trusted. This is the normal case the
board's one-request fast path is for: three rows, all with
`created_by_worker: ""` and `created_by_session: ""`, no `retracted_by` key.

### `board-latest-per.json`
The same request over the tampered fixture set — and the point of it is what is
**missing**. Four hypotheses existed; two rows come back:

- `1a2b3c4d` — trusted, `status=live`.
- `2b3c4d5e` — `status=confirmed` written by `researcher-2b3c4d5e` /
  `sess-b31f0c9a`. The forged newer row wins `latest_per` exactly as the trust
  model says it would.
- `3c4d5e6f` and `4d5e6f70` are **absent entirely** — both had their state row
  retracted, and the default read filters retracted rows out
  (`notRetractedSQL`, `go/agentdb/memories.go:342-346`). This is the attack
  W5's retraction criterion exists for: a hypothesis silently vanishing from
  the board.

### `board-latest-per-include-retracted.json`
The same request with `&include_retracted=1` (O11). All four rows come back,
the retracted ones carrying `retracted_by`.

### `detail-<id>-include-retracted.json`
`GET /agent/memories?selector=kind%3Dhypothesis,name%3D<id>&limit=50&include_retracted=1`
— the per-name follow-up W5 issues for an anomaly. Rows are **newest first**.

| File | What it pins |
| --- | --- |
| `detail-1a2b3c4d-…` | Clean history: `live` then `draft`, both trusted, no `retracted_by` key on either. |
| `detail-2b3c4d5e-…` | Forged row: newest is the researcher's `status=confirmed`, beneath it Wolf's trusted `status=live`. The reported status must stay `live`, with `Tamper{reason:"forged_row"}`. |
| `detail-3c4d5e6f-…` | **Hostile retraction**: one trusted `status=live` row, retracted by a memory written by `sess-77c1e2d5`. `retracted_by` has exactly one entry and its `created_by_session` is non-empty. The retraction must be ignored for state and surfaced as `Tamper{reason:"hostile_retraction"}`. |
| `detail-4d5e6f70-…` | **The resurrection attempt** (owner decision B5): Wolf retracted its own `draft` row, and then `researcher-4d5e6f70` retracted it too. `retracted_by` carries **both**, newest first — the hostile one first. A reader that looks only at `retracted_by[0]` discards it as untrusted and resurrects a row Wolf legitimately withdrew. The row counts as retracted because **at least one** retraction of it has empty provenance, and the hostile one still raises `Tamper`. |

### `sessions-interviewer-page{1,2,3}.json`
`GET /agent/sessions?user_email=*&worker=interviewer&limit=2&offset={0,2,4}` —
a real three-page walk (2, 2, then 1 row, which is how the pager knows to stop).
Six sessions existed; these pages pin all three filters at once:

- `user_email=*` is load-bearing — the API key's synthetic email is
  `api-key:wolf`, which matches no session row without it (visible in the
  bodies).
- `worker=interviewer` excludes `tick-1a2b3c4d-20260821`
  (`worker=researcher-1a2b3c4d`), which the default `updated_at DESC` ordering
  would otherwise push a `draft` hypothesis off the index with.
- `settings-chat` is present and is **not** a hypothesis: the `hyp-*` name
  filter is applied by Wolf, on the client side, and these pages are what it is
  applied to.

Note the row shape: `name`, `worker`, `status`, `created_at`/`updated_at` in
unix **seconds** (the `agent_*` tables' unit), among many other fields Wolf
ignores.

### `snippet-truncation.json`
`GET /agent/memories?selector=kind%3Dhypothesis&latest_per=name&limit=100` over
five hypotheses chosen to pin the snippet contract, which the title parser
depends on. Measured on the captured bodies:

| `name` | snippet chars | snippet bytes | contains `\n` | line 1 |
| --- | --- | --- | --- | --- |
| `1a2b3c4d` | 81 | 81 | yes | 50 chars — a complete short title |
| `2b3c4d5e` | 95 | 95 | yes | 38 chars — a complete short title (this row is the forged one; it is here for its snippet, not its provenance) |
| `5e6f7081` | 500 | 500 | **no** | a 600-character ASCII first line, cut at 500 |
| `6f708192` | 500 | **1500** | **no** | a 630-character multibyte first line, cut at 500 |
| `708192a3` | 500 | **1496** | yes | a 200-character multibyte title, parsed **exactly** |

This is the proof that `substring(content, 1, 500)` on a `text` column is
**character**-based, not byte-based (`go/agentdb/memories.go:35,451-452`): 500
characters and 1500 bytes in the same body. It is also why no test tries to
construct a mid-multibyte split — the server cannot produce one.

### `memory-by-id-1a2b3c4d.json`
`GET /agent/memories/{id}` — the **full-content** read (T18 of the embeddable
plan), which is what `transition()` uses to carry a hypothesis's title and
thesis forward into the row it appends. The body has a `content` field and no
`snippet`; the content is line 1 = title, then the prose thesis, then the
fenced `json` block this codebase writes `owner_email` into, because the full
address may never be a label value.

---

## The second capture (W5 fix round 1, 2026-08-21)

The board's fast path originally read **without** `include_retracted=1`, exactly
as the plan's board criterion is written. That leaves a hole: Orange applies its
retraction filter **before** the `latest_per` reduction, so a hostile retraction
of Wolf's *newest* state row does not hide the hypothesis — it promotes the
**older trusted row beneath it**, which passes every clause of `isTrusted`. The
board then renders the previous status with no anomaly and no tamper warning,
while the detail read shows the true one.

Rather than argue that from a mock, the case was **seeded and read from a
running build**, and the two bodies below are the same query one query parameter
apart.

| | |
| --- | --- |
| Repo / commit | `agent-bob` **`af0e0cb1f4ed91fc9b00f73e8e51b413d6349eaf`** — the same commit as the first capture, extracted with `git archive` and built with `go build -o agentd ./cmd/agentd` |
| Captured | **2026-08-21** |
| Store | the same throwaway `pgvector/pgvector:pg16` instance (port 5436), a **fresh database** (`w5fix`), migrations `001`–`045` applied by `agentd` itself at boot |
| Model | **mock** — `[agentd] ANTHROPIC_API_KEY unset → MOCK model proxy (set it for a real agent)` in the boot log. No billable agent ran |
| Projects | `wolf` (the tampered set) and `wolfclean` (the untampered board), each reached with its own throwaway API key generated for the capture and never written down |
| Sessions | **none were created.** These bodies are memory reads only; the session-index fixtures from the first capture are unchanged and still real |

Provenance was written the same two ways as before: every trusted row through
the real `POST /agent/memories` route (`201`, provenance stamped empty by the
server), and the hostile retraction through `agentdb.Store.CreateMemory` with
`CreatedByWorker`/`CreatedBySession` filled the way the core MCP server's
`memory_create` fills them — there is no HTTP route that can stamp provenance,
by design.

### What was seeded

- **`1a2b3c4d`** — Wolf appended `status=draft`, then `status=live`. A
  researcher session (`researcher-1a2b3c4d` / `sess-c0ffee11`) then appended a
  memory carrying `retracts=<the live row's id>`. **This is the attack.**
- **`2b3c4d5e`** — one trusted `status=live` row, untouched. The control.
- **`3c4d5e6f`** — Wolf appended `status=live`, then `status=challenged` in
  error, then retracted the `challenged` row **itself** (empty provenance). The
  mirror image: this retraction *is* honoured, and the answer is the row
  underneath.

### The files

| File | Query | What it pins |
| --- | --- | --- |
| `board-resurrection-default.json` | `…&latest_per=name&limit=100` | **The hole.** `1a2b3c4d` comes back as `status=draft` — a different row id, with empty provenance, indistinguishable from the truth. `3c4d5e6f` comes back as `live`. |
| `board-resurrection-include-retracted.json` | the same **`&include_retracted=1`** | `1a2b3c4d` is `status=live` with the researcher's retraction in `retracted_by`; `3c4d5e6f` is the `challenged` row with **Wolf's own** retraction attached. |
| `detail-1a2b3c4d-resurrection-include-retracted.json` | `…name%3D1a2b3c4d&limit=50&include_retracted=1` | The follow-up view of the attacked hypothesis: `live` (hostilely retracted) over `draft`. |
| `detail-3c4d5e6f-wolf-retraction-include-retracted.json` | the same for `3c4d5e6f` | `challenged` (retracted by Wolf) over `live` — the fall-through the board pays one follow-up for. |
| `board-all-trusted-include-retracted.json` | `…&latest_per=name&limit=100&include_retracted=1` over project `wolfclean` | The **flagged** fast path on a clean board: three trusted rows, and **no `retracted_by` key anywhere** — which is why carrying the flag costs the normal case nothing. |

`board-all-trusted.json` (first capture, unflagged) is kept and is still
asserted on, as the other half of that last comparison.
