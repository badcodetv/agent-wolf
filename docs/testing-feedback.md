# Where tester feedback lands

Operator-facing. The note testers themselves read is [`for-testers.md`](./for-testers.md).

There is **no in-app feedback widget, and deliberately so** — one more half-built surface to
maintain, on a product whose whole first round is five people who can all reach Kai directly.
Feedback arrives out of band and is triaged here by hand.

## The channels, in the order they are worth reading

| Channel | Who uses it | Where it goes |
| --- | --- | --- |
| **WhatsApp / a message to Kai** | Everyone, in practice | Triaged into this file's backlog below, same day |
| **GitHub issues** on `badcodetv/agent-wolf` | Kai, after triage | The durable record. One issue per defect, never per conversation |
| **Whatever the session itself recorded** | Nobody, directly | See "What the system already knows", below |

The first channel is the real one. Do not build a second until the first is a burden.

## What the system already knows without anyone reporting it

Before chasing a tester for detail, look here — three of the four things a bug report usually asks
for are already on disk.

- **The whole conversation.** Every interview and every researcher run is a session in Agent Bob,
  with its full event stream in Postgres. A tester saying "the interview went weird" is a session
  you can replay, not a memory you have to reconstruct.
- **Every state change, with its rationale.** Hypotheses move through `draft → live → challenged →
  confirmed | invalidated | archived`, and each transition is an appended memory. Nothing is
  overwritten, so "it changed on its own" is answerable.
- **What the researcher actually read.** Market-data series are stored as versioned datasets, so a
  disputed number can be checked against the bytes the run saw, not against today's data.
- **`wolf-api`'s logs**, one JSON line per request via `pino`. Credentials and download URLs are
  never logged; a report mentioning either means a real defect, report it as one.

What is **not** recorded anywhere: what the tester expected to happen. That is the one thing worth
asking for, and it is why `for-testers.md` asks for it in those words.

## Triage

Three buckets, and the middle one is the point of the exercise.

1. **Broken** — it errored, hung, or showed something plainly wrong. GitHub issue, reproduce from
   the session replay first.
2. **Confusing** — it worked exactly as designed and the tester still misread it. **These are the
   valuable ones.** They are not bugs and they must not be filed as bugs, or they will be closed
   as "works as intended" and the lesson lost. Record them below.
3. **Wanted** — a feature that does not exist. Note it, do not build it during a test round.

## Known-confusing, from the design (expect these before anyone reports them)

Recorded so that a tester hitting one is confirmation rather than news:

- **The support score decides nothing.** It is a human summary; only conditions trip anything. The
  design makes "say so in the UI" an acceptance criterion, which is an admission this will be
  misread.
- **Nothing happens for the first day.** The researcher runs daily; a hypothesis stated at noon
  shows no research until the next morning.
- **The scoreboard locks at go-live.** Intended, and it will read as a missing edit button.
- **Terminal states are terminal.** Re-running a changed idea means a new hypothesis carrying
  `restated_from`.
- **Research notes are advisory, not state.** Anything written inside a session container is
  marked untrusted by construction and is shown as evidence, never as a fact about the hypothesis.

## The backlog

One line per item: date, tester, bucket, what happened. Rewrite rather than append forever; move
anything real to a GitHub issue and leave the issue number here.

*(Empty — no test round has run. First round: Kai only, from 2026-09-12.)*

## Removing a tester

Not feedback, but it belongs with it: taking someone off the allowlist takes effect on their very
next request, not when their login expires. Editing the list and restarting `wolf-api` is the
whole operation, and it costs nothing because Wolf stores no session state of its own. Steps are in
agent-bob's `design/2026-09-12-wolf-deployment.md` § 6.
