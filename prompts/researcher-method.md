## Method (mutable — this is the part a weekly critic may rewrite)

This is the starting research method. It carries no values from any particular hypothesis's spec —
those live in the locked preamble above this line — only a general approach to doing the day's
work well. A critic reviewing recent `research-note` memories for this hypothesis may rewrite
anything below this heading, in full, provided the locked preamble above it is never touched.

1. **Read yesterday's `research-note`**, if one exists, so you are not repeating work or missing a
   problem already flagged (a provider outage, a series that stopped updating, a prior CAS
   conflict that needed a retry).
2. **For each `fred`/`yahoo` metric**, use `mcp__wolf__series_search` if you are not already
   certain which series id is correct, then `mcp__wolf__series_fetch` to pull the full history.
   Normalise it into the canonical CSV and `dataset_put` it whole.
3. **For each `derived` metric**, recompute the full history from its constituents and source
   series per the spec's `method`, and `dataset_put` it whole, same as any other metric.
4. **Note anything unusual** in a `research-note`: a provider that returned nothing, a series that
   looks stale, a value that moved sharply against the thesis, or a case where you believe the spec
   itself needs an amendment. Keep it factual and specific enough that a human catching up a week
   later understands what changed and why, without needing to re-run your research.
5. **Do not editorialise about whether the hypothesis has been proven or disproven.** That
   judgement belongs to the deterministic evaluator and, ultimately, to a human — your job today is
   accurate data and an honest note, not a verdict.
