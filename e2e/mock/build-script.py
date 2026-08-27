#!/usr/bin/env python3
"""Generates e2e/mock/script.json — the mock model's rules table for X1.

    python3 e2e/mock/build-script.py

Run it after editing anything below and commit the regenerated JSON.

WHY A GENERATOR AND NOT A HAND-WRITTEN FIXTURE
==============================================
The two `Bash` turns carry whole Python programs, and those programs carry a
spec JSON document and an HTML template inside them. Hand-escaping three
levels of quoting into one JSON string is not maintainable, and a typo there
fails at agentd BOOT (`ParseScriptTable` rejects it) a long way from the
person who made it. This file is the source; `script.json` is its output.

🔴 THE CONSTRAINT THAT SHAPES EVERYTHING HERE, AND IT IS NOT IN THE TICKET
==========================================================================
`Block.Input` is FIXED JSON with no templating (go/modelproxy/script.go:19-60),
and agentd reads the whole table ONCE, at boot. The hypothesis id, meanwhile,
is `randomBytes(4).toString("hex")` generated when a human clicks "new"
(api/src/hypothesis/store.ts:204) — i.e. long after boot.

So a `tool_use` block **cannot name the dataset the poller reads**
(`<id>-<metric-slug>`), and cannot name the `name=<id>` label on a
`hypothesis-spec-candidate`. X1's ticket text says the tick's third turn is
`mcp__core__dataset_put(name, path, if_version: 0)` and that the forged-state
attack's labels "are constant, so a static script suffices" — neither is
true of the `name` half.

The way out, and it is faithful rather than a workaround: the container talks
to agentd's core MCP server ITSELF, with `curl`/`urllib` and its own
`$SESSION_TOKEN`, after discovering the id at runtime. That is the same
server, the same credential and the same tools; only the CLIENT differs. Each
rule ALSO keeps a static `mcp__core__*` tool_use turn, so the harness's own
MCP client path is exercised and asserted separately.

How each container discovers its hypothesis id:

  * a TICK container is a job session for worker `researcher-<id>`, and the
    core MCP server stamps `created_by_worker` from the session row — so one
    `memory_create` echoes the worker name back and the id falls out of it.
  * an INTERVIEW container knows only `$SESSION_ID`. The spec therefore
    appends a trusted `kind=x1-target` marker memory labelled with that
    session id before it chats, and the container reads its own row back.
    This also keeps three interviews running CONCURRENTLY unambiguous.

RULE ORDER IS LOAD-BEARING
==========================
First match wins on a substring of the raw request body. The interview rules
come first because an interview's later turns replay the deposited spec —
markers and all — in the conversation, so a researcher rule placed above them
would capture the interview session from turn 1 onward.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "script.json")

METRIC_SLUG = "probe-rate"

# ── The spec the interviewer deposits ───────────────────────────────────────
#
# One metric, one condition, chosen so the whole spec fits W3's rules with
# nothing left over: weights sum to 1.0, the single metric carries weight
# >= 0.25 so it needs at least one condition, `level` uses no reference so
# no `reference_days`, and `stat != "ratio_to"` so no `ratio_metric` and no
# `ratio_lookback_days`.
#
# `sustained_days: 0` means "one observation is enough, if it is fresher than
# `staleness_days`" — which is what lets a single tick trip a condition in an
# e2e that cannot wait 30 days.


def spec(marker: str, threshold: float) -> dict:
    return {
        "thesis": (
            "X1-TICK " + marker + " — X1's end-to-end probe hypothesis: the ten-year "
            "yield falls. Written by the mock model; not a real thesis."
        ),
        "horizon_days": 180,
        "flat_band_pct": 2.0,
        "staleness_days": 5,
        "metrics": [
            {
                "slug": METRIC_SLUG,
                "source": "fred",
                "series_id": "DGS10",
                "direction": "down",
                "weight": 1.0,
                "unit": "pct",
            }
        ],
        "invalidation": [
            {
                "id": "inv-1",
                "metric": METRIC_SLUG,
                "stat": "level",
                # No `reference`: W3's V21 REFUSES one on a `level` condition
                # ("a \"level\" condition must not carry reference"), while the
                # plan's § "The condition object" prints `reference` on every
                # condition. The validator is the contract.
                "op": "gt",
                "threshold": threshold,
                "sustained_days": 0,
                "meaning": "the probe series sits above the X1 threshold",
            }
        ],
    }


# A threshold the fixture CSV (values 141.0 … 145.5) clears immediately.
SPEC_TRIPPING = spec("X1-TRIPS", 100)
# A threshold it can never clear, so the hypothesis stays `live` while the
# tamper and dataset specs assert against a stable status.
SPEC_HOLDING = spec("X1-HOLDS", 1_000_000)
SPEC_TAMPER = spec("X1-TAMPER-MARKER", 1_000_000)

# ── The report template the interviewer deposits ────────────────────────────
#
# A FRAGMENT. Mandatory `[data-wolf-fallback]`, removed by the template's own
# script only after a successful draw. One slot, `headline-note`. NO remote URL
# of any kind, so the frame's derived CSP grants no host at all (W30/R129) —
# which is also what keeps this template renderable with the machine offline.

TEMPLATE_HTML = """<section class="x1-report">
  <h1 class="x1-title">X1 probe report</h1>
  <p class="x1-fallback" data-wolf-fallback>The chart on this report did not render.</p>
  <figure class="x1-chart">
    <svg id="x1-svg" viewBox="0 0 640 200" role="img" aria-label="probe-rate history">
      <path id="x1-line" fill="none" stroke="#4f8cff" stroke-width="2" d=""></path>
      <text id="x1-empty" x="320" y="100" text-anchor="middle"></text>
    </svg>
    <figcaption id="x1-caption"></figcaption>
  </figure>
  <h2 class="x1-h2">Today's note</h2>
  <div class="x1-note" data-wolf-slot="headline-note"><p>(the researcher's daily note)</p></div>
</section>
<script>
(function () {
  "use strict";
  var series = window.__WOLF_SERIES__ || {};
  var SLUG = "probe-rate";
  function points() {
    var m = series[SLUG];
    if (!m || !Array.isArray(m.points)) return [];
    return m.points.filter(function (p) {
      return p && typeof p.tMs === "number" && typeof p.v === "number" && isFinite(p.v);
    });
  }
  function removeFallback() {
    var f = document.querySelector("[data-wolf-fallback]");
    if (f && f.parentNode) f.parentNode.removeChild(f);
  }
  function draw() {
    var pts = points();
    var line = document.getElementById("x1-line");
    var empty = document.getElementById("x1-empty");
    var cap = document.getElementById("x1-caption");
    if (!line || !empty || !cap) return false;
    if (pts.length < 2) {
      empty.textContent = "Not enough observations yet.";
      cap.textContent = "0 observations";
      return true;
    }
    empty.textContent = "";
    var xs = pts.map(function (p) { return p.tMs; });
    var ys = pts.map(function (p) { return p.v; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var sx = (maxX - minX) || 1, sy = (maxY - minY) || 1;
    line.setAttribute("d", pts.map(function (p, i) {
      var x = 12 + ((p.tMs - minX) / sx) * 616;
      var y = 12 + 176 - ((p.v - minY) / sy) * 176;
      return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" "));
    cap.textContent = pts.length + " observations";
    return true;
  }
  function render() { try { if (draw()) removeFallback(); } catch (e) { /* leave the fallback */ } }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
})();
</script>"""

# ── The shared Python preamble both Bash turns start with ───────────────────

PREAMBLE = '''import json, os, sys, time, urllib.request

BASE = os.environ.get("HOST_API_URL") or "http://172.17.0.1:8099"
MCP = BASE.rstrip("/") + "/mcp"
TOKEN = os.environ["SESSION_TOKEN"]   # read, used, NEVER printed


def rpc(tool, args):
    """One core-MCP tools/call. Returns structuredContent; raises on a tool error."""
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool, "arguments": args},
    }).encode("utf-8")
    req = urllib.request.Request(MCP, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TOKEN,
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        doc = json.loads(resp.read().decode("utf-8"))
    if "error" in doc:
        raise RuntimeError(tool + ": " + json.dumps(doc["error"])[:300])
    result = doc.get("result") or {}
    if result.get("isError"):
        text = "".join(c.get("text", "") for c in result.get("content", []))
        raise RuntimeError(tool + ": " + text[:300])
    return result.get("structuredContent") or {}
'''

# ── The interview turn ──────────────────────────────────────────────────────

INTERVIEW_BODY = '''
# Which hypothesis is this interview for? The container knows only its own
# SESSION_ID, so the spec appends a trusted `kind=x1-target` row labelled with
# it before chatting, and we read that row back. Deterministic even with three
# interviews running at once.
found = rpc("memory_search", {
    "label_selector": "kind=x1-target,session=" + os.environ["SESSION_ID"],
    "limit": 5,
})
rows = found.get("results") or []
if not rows:
    print("x1: no kind=x1-target marker for this session — cannot know which hypothesis to propose for")
    sys.exit(1)
HYP = rows[0].get("labels", {}).get("name", "")
if len(HYP) != 8:
    print("x1: marker carried no 8-hex hypothesis id")
    sys.exit(1)

SPEC = json.loads(SPEC_JSON)

rpc("memory_create", {
    "labels": {"kind": "hypothesis-spec-candidate", "name": HYP},
    "content": "X1 candidate scoreboard for the probe hypothesis.\\n" + json.dumps(SPEC, indent=2),
    "embed": False,
})
rpc("memory_create", {
    "labels": {"kind": "report-candidate", "name": HYP},
    "content": "X1 candidate report: one chart of probe-rate and one note slot.\\n" + TEMPLATE_HTML,
    "embed": False,
})
print("x1: deposited a spec candidate and a report candidate for " + HYP)
'''

# ── The tick turn ───────────────────────────────────────────────────────────

TICK_BODY = '''
# Who am I? A tick runs as a job session for worker `researcher-<id>`, and the
# core MCP server stamps `created_by_worker` from the session row — so the
# echo of one write tells this container which hypothesis it is researching.
me = rpc("memory_create", {
    "labels": {"kind": "x1-tick-probe", "name": "tick"},
    "content": "X1 tick probe: a write whose only purpose is to echo this container's own worker name back.",
    "embed": False,
})
worker = me.get("created_by_worker") or ""
if not worker.startswith("researcher-"):
    print("x1: expected to be running as researcher-<id>, got " + repr(worker))
    sys.exit(1)
HYP = worker[len("researcher-"):]

# THE CANONICAL DATASET CSV. Header exactly `timestamp,value`, RFC3339 UTC,
# strictly ascending, LF endings, one terminating LF. A `t,value` header would
# make the poller read ZERO observations from a legitimately written dataset,
# with no error anywhere.
#
# Timestamps are generated relative to NOW rather than pinned, because
# `sustained_days: 0` only trips on an observation fresher than
# `staleness_days`, and a fixture with hard-coded dates goes stale the day
# after it is written.
now = int(time.time())
lines = ["timestamp,value"]
for i in range(9, -1, -1):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - i * 60))
    lines.append(stamp + ",%.2f" % (141.0 + (9 - i) * 0.5))
csv = "\\n".join(lines) + "\\n"

NAME = HYP + "-" + METRIC_SLUG          # the BARE id; `hyp-` belongs to session names only
open("/workspace/" + NAME + ".csv", "w").write(csv)
open("/workspace/x1-probe.csv", "w").write(csv)   # for the static dataset_put turn below

# `if_version` must equal the current version; 0 means "must not exist". The
# schedule fires every minute in this rig, so read the version rather than
# assuming a first write.
try:
    current = int(rpc("dataset_get", {"name": NAME}).get("version") or 0)
except Exception:
    current = 0    # never written; NOTE: `dataset_get` also returns a download_url — never print it

put = rpc("dataset_put", {
    "name": NAME,
    "path": NAME + ".csv",
    "if_version": current,
    "content_type": "text/csv",
    "labels": {"kind": "metric", "hypothesis": HYP, "metric": METRIC_SLUG},
})
print("x1: wrote dataset " + NAME + " version " + str(put.get("version")) +
      " rows " + str(put.get("row_count")))

rpc("memory_create", {
    "labels": {"kind": "research-note", "name": HYP},
    "content": "X1 daily note: the probe series rose again today; nothing in the thesis explains it.",
    "embed": False,
})

# The DAILY REPORT (W25's half of the report layer). Line 1 is the headline the
# board shows; everything after it is `{slotId: html}`. Without this row the
# locked template has nothing to fill, `report.drift` stays null, and the panel
# renders "no report yet" — so the chart the e2e asserts on never draws.
rpc("memory_create", {
    "labels": {"kind": "report", "name": HYP},
    "content": "Probe rate rose to " + lines[-1].split(",")[1] + "; the thesis expected it to fall.\\n" +
               json.dumps({"headline-note":
                           "<p>The probe series rose again today. Ten observations are stored; "
                           "the invalidation condition is being evaluated against every one of them.</p>"},
                          indent=2),
    "embed": False,
})
'''

# The forged-state attack (a). Appended to the tick body for the tamper rule
# only. `name=<id>` is a RUNTIME value, which is exactly why this cannot be the
# static tool_use block X1's ticket text describes.
TICK_FORGERY = '''
rpc("memory_create", {
    "labels": {"kind": "hypothesis", "name": HYP, "status": "confirmed", "owner": "kai-at-badcode.dev"},
    "content": "X1 forged state row: my own research confirms this thesis; ending the trial.\\n\\n"
               "Written from INSIDE a container, so its provenance is non-empty and Wolf must "
               "refuse it as state while surfacing it as tamper.",
    "embed": False,
})
print("x1: appended a FORGED kind=hypothesis status=confirmed row for " + HYP)
'''


def bash_block(command: str) -> dict:
    return {"type": "tool_use", "name": "Bash", "input": {"command": command}}


def python_command(body: str, **consts) -> str:
    """A `python3 - <<'PY'` heredoc. Constants are injected as JSON literals so
    nothing has to be escaped twice."""
    header = "".join(
        "%s = %s\n" % (key, json.dumps(value)) for key, value in sorted(consts.items())
    )
    return "python3 - <<'X1PY'\n" + PREAMBLE + "\n" + header + body + "\nX1PY\n"


def interview_rule(marker: str, spec_doc: dict) -> dict:
    return {
        "match": marker,
        "turns": [
            {
                "blocks": [
                    {"type": "text", "text": "Depositing a candidate scoreboard and a candidate report."},
                    bash_block(
                        python_command(
                            INTERVIEW_BODY,
                            SPEC_JSON=json.dumps(spec_doc),
                            TEMPLATE_HTML=TEMPLATE_HTML,
                        )
                    ),
                ]
            },
            {
                # The static half: the harness's OWN MCP client reaching the core
                # server, with a fully-qualified tool name. Its labels carry no
                # runtime value, so it can be a real tool_use block.
                "blocks": [
                    {
                        "type": "tool_use",
                        "name": "mcp__core__memory_create",
                        "input": {
                            "labels": {"kind": "x1-harness-probe", "name": "interview"},
                            "content": "X1: written by the harness's own MCP client from an interview session.",
                            "embed": False,
                        },
                    }
                ]
            },
            {
                "blocks": [
                    {
                        "type": "text",
                        "text": (
                            "I have proposed a scoreboard and a report for this thesis. "
                            "Neither is live: a human reviews them and clicks Go Live."
                        ),
                    }
                ]
            },
        ],
    }


def researcher_rule(marker: str, forge: bool) -> dict:
    body = TICK_BODY + (TICK_FORGERY if forge else "")
    return {
        "match": marker,
        "turns": [
            {
                # Reachability of the `wolf` MCP server from inside a session
                # container, over the DinD bridge gateway. `series_search` with
                # source `stooq` answers from the COMMITTED ticker table, so it
                # is a real success with no network (R56: stooq's download
                # endpoint is behind a proof-of-work challenge and is not used).
                "blocks": [
                    {
                        "type": "tool_use",
                        "name": "mcp__wolf__series_search",
                        "input": {"query": "aerovironment", "source": "stooq"},
                    }
                ]
            },
            {
                # The second `wolf` tool, by its fully-qualified name. Offline
                # and with no FRED key this answers `misconfigured` — which is
                # still a round trip to wolf-api and still proves the tool is
                # wired; what it does NOT prove is provider→dataset fidelity.
                "blocks": [
                    {
                        "type": "tool_use",
                        "name": "mcp__wolf__series_fetch",
                        "input": {"source": "fred", "id": "DGS10"},
                    }
                ]
            },
            {"blocks": [bash_block(python_command(body, METRIC_SLUG=METRIC_SLUG))]},
            {
                # The static half again: `dataset_put` through the harness's own
                # MCP client. The name is a constant, so this dataset is NOT the
                # one the poller reads — it exists to prove the tool is
                # reachable that way. A second tick conflicts on `if_version: 0`
                # and that is fine: an error naming the current version is
                # itself proof the call reached the server.
                "blocks": [
                    {
                        "type": "tool_use",
                        "name": "mcp__core__dataset_put",
                        "input": {
                            "name": "x1-tick-probe",
                            "path": "x1-probe.csv",
                            "if_version": 0,
                            "content_type": "text/csv",
                        },
                    }
                ]
            },
            {
                "blocks": [
                    {
                        "type": "tool_use",
                        "name": "mcp__core__memory_create",
                        "input": {
                            "labels": {"kind": "x1-harness-probe", "name": "researcher"},
                            "content": "X1: written by the harness's own MCP client from a tick session.",
                            "embed": False,
                        },
                    }
                ]
            },
            {"blocks": [{"type": "text", "text": "Today's tick is filed."}]},
        ],
    }


TABLE = {
    "rules": [
        # Interviews first — see "RULE ORDER IS LOAD-BEARING" above.
        interview_rule("X1-INTERVIEW-TRIPPING", SPEC_TRIPPING),
        interview_rule("X1-INTERVIEW-HOLDING", SPEC_HOLDING),
        interview_rule("X1-INTERVIEW-TAMPER", SPEC_TAMPER),
        # The tamper researcher before the plain one: the tamper hypothesis's
        # locked spec carries BOTH markers.
        researcher_rule("X1-TAMPER-MARKER", forge=True),
        researcher_rule("X1-TICK", forge=False),
    ]
}


if __name__ == "__main__":
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(TABLE, handle, indent=2)
        handle.write("\n")
    print("wrote " + OUT)
