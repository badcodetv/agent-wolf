#!/usr/bin/env bash
#
# X1 — the end-to-end rig. Brings up BOTH stacks in offline mock-model mode,
# bootstraps the `wolf` project, runs the Playwright specs, and cleans up after
# itself on every exit path.
#
#   ./e2e/run.sh                      run every spec
#   ./e2e/run.sh tamper-resistance    run e2e/features/tamper-resistance.spec.ts only
#   ./e2e/run.sh --down               stop both stacks and exit
#
# An unknown spec name exits non-zero rather than passing vacuously with zero
# tests — a filter that matches nothing is the loudest kind of false green.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT THIS SCRIPT KNOWS THAT NOTHING ELSE IN THE REPO DOES
#
# 1. NO BILLABLE CALL, EVER. agent-orange's real `.env` on a developer machine
#    carries live model credentials and a GCS backend that kills agentd at boot
#    (README-stack.md § "If you have a real .env: two traps"). Every override in
#    ORANGE_ENV below is load-bearing, and `assert_mock_mode` fails the run if
#    agentd's own boot line does not say it chose a mock model.
#
#    🔴 The boot line is NOT the one X1's acceptance criterion quotes. With a
#    mock SCRIPT configured — which this rig always does — agentd prints
#      [agentd] ANTHROPIC_API_KEY unset → SCRIPTED mock model proxy (N rule(s))
#    and never the scriptless
#      [agentd] ANTHROPIC_API_KEY unset → MOCK model proxy (set it for a real agent)
#    that README-stack.md documents (go/cmd/agentd/modelproxy.go:59 vs :62 —
#    the two are exclusive branches). A run.sh written to the criterion's
#    literal string would fail every single run. We assert the SCRIPTED form,
#    and separately assert that neither real-model line is present.
#
# 2. THE TWO STACKS' DEFAULT PORTS COLLIDE. Orange's mock invocation takes 8081
#    and Wolf's default WOLF_WEB_PORT is 8081. Pinned here: Orange 8090,
#    Wolf 8091, and wolf-web is BUILT with VITE_ORANGE_PUBLIC_URL=:8090 (vite
#    inlines it; an `environment:` entry cannot reach a built bundle).
#
# 3. http://localhost:8091 MUST be in the `wolf` project's allowed_origins or
#    the Orange embed page's `frame-ancestors` blocks the chat iframe outright,
#    which reads as a broken UI rather than as a config error.
#
# 4. 🔴 WOLF_MCP_URL IS SET EXPLICITLY, AND IT HAS TO BE. wolf-api's boot-time
#    probe (api/src/config.ts, R43) reads DinD's DEFAULT ROUTE, which in the
#    compose stack is the OUTER compose-network gateway (172.26.0.1 on the
#    machine this was written on) — not DinD's INNER docker0 gateway
#    (172.17.0.1), which is the address a nested session container actually
#    reaches wolf-api on. Measured, from inside DinD:
#        curl 172.17.0.1:8100/mcp  → 401   (reachable, credential refused)
#        curl 172.26.0.1:8100/mcp  → exit 7 (could not connect)
#    So the discovered value is unreachable and every mcp__wolf__* tool call
#    would time out with no obvious cause. The design says an explicitly-set
#    WOLF_MCP_URL wins and that "a real deployment sets it and never runs the
#    probe" — this rig is that deployment. `dind_gateway` reads docker0's own
#    address out of DinD, which is the route the probe should have read.
#
# 5. A HOST-BUILT IMAGE IS INVISIBLE INSIDE DinD. scripts/load-image-into-dind.sh
#    runs before any hypothesis is created, or the tick runs in an image with no
#    python and no curl.
#
# ─────────────────────────────────────────────────────────────────────────────
# SAFETY
#
# * No credential is ever printed. Secrets are generated into a run-scoped
#   file under a mktemp -d directory, `chmod 600`, and referenced by NAME.
# * `dcc` (below) is the only permitted way to look at compose config:
#   `docker compose config` interpolates and prints secrets (R82).
# * 🔴 CLEANUP DELETES ONLY THE ATOMS THIS RUN RECORDED CREATING, and the
#   sentence that used to sit here — "cleanup never touches a container this
#   script did not create" — was true of CONTAINERS and read as a much broader
#   promise than it kept. It did not hold of PROJECT STATE: the first version
#   listed every schedule in the `wolf` project and deleted all of them, which
#   was invisible in the rig (bootstrap re-creates the critic schedule, and
#   reported `"criticSchedule":"created"` every single run instead of
#   `"unchanged"`) and would have destroyed live state on a project holding real
#   hypotheses — every researcher schedule and every session. Found by X1's
#   verifier, not self-reported.
#
#   🔴 SCOPING BY NAME PATTERN WOULD NOT HAVE FIXED IT. Real hypotheses are also
#   named `hyp-<id>` with `researcher-<id>` workers, so a `hyp-*` sweep destroys
#   exactly the state the danger is about. The fix is a RUN MANIFEST: the specs
#   append every hypothesis id they create (see `X1_RUN_MANIFEST`), and cleanup
#   deletes only those ids' schedules and sessions. Anything else in the project
#   is COUNTED AND REPORTED, never deleted.
#
#   What cleanup may do, exhaustively: DELETE `/agent/schedules/{id}` and
#   `/agent/session/{id}` for manifest ids only; and `docker compose -p <one of
#   our two project names> down` under `--down`. It never runs `docker rm`,
#   `docker stop` or `docker kill`, and never names a container id.

set -euo pipefail

# ── Where things are ────────────────────────────────────────────────────────

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WOLF_REPO="$(cd "${E2E_DIR}/.." && pwd)"
# Two layouts, and BOTH are real. The canonical checkout is a SIBLING
# (`/…/badcode/agent-wolf` beside `/…/badcode/agent-orange`); a per-ticket
# worktree sits one level deeper (`/…/badcode/wave18/x1`). The first version of
# this line knew only the worktree layout, so running from the canonical
# checkout — which is where it lives — failed to find Orange at all. It failed
# CLOSED with the right message, which is the correct direction, but a rig that
# cannot find its own sibling by default is a rig everyone runs with an
# environment variable they should not need.
if [ -z "${ORANGE_REPO:-}" ]; then
  for candidate in "${WOLF_REPO}/../agent-orange" "${WOLF_REPO}/../../agent-orange"; do
    if [ -f "${candidate}/docker-compose.yml" ]; then
      ORANGE_REPO="$(cd "${candidate}" && pwd)"
      break
    fi
  done
fi

if [ -z "${ORANGE_REPO:-}" ] || [ ! -f "${ORANGE_REPO}/docker-compose.yml" ]; then
  echo "run.sh: cannot find the agent-orange checkout." >&2
  echo "        Looked for a docker-compose.yml in:" >&2
  echo "          ${WOLF_REPO}/../agent-orange      (sibling checkout)" >&2
  echo "          ${WOLF_REPO}/../../agent-orange   (per-ticket worktree)" >&2
  echo "        Set ORANGE_REPO=/path/to/agent-orange and re-run." >&2
  exit 2
fi

# ── 🔴 ONE RUN AT A TIME. THE COMPOSE STACK IS A SERIAL RESOURCE ────────────
#
# README-stack.md says so in as many words, and this rig ignored it — which
# produced the single worst class of false result X1 has had.
#
# `run.sh` mints a fresh WOLF_API_KEY per invocation and bakes it into agentd at
# BOOT (agentd resolves the project map's `api_key_env` once, at start —
# go/cmd/agentd/apikey.go). So a SECOND invocation's `docker compose up -d`
# recreates agentd with a NEW key and the FIRST run's key stops working
# instantly, mid-flight. Measured, in seconds:
#
#     agentd booted with K1;  GET /agent/sessions with K1  → 200
#     second `up -d` with K2 (recreates agentd)
#     GET /agent/sessions with K1  → unauthorized
#     GET /agent/sessions with K2  → 200
#
# The first run then fails wherever its specs happen to be — a DIFFERENT set of
# tests each time, in unrelated spec files, with tests that passed moments
# earlier. That is not flakiness and it is not a product defect: it is two runs
# rotating a shared credential out from under each other. It cost a full round
# of "the suite is not reproducible".
#
# `-n` so a second run fails FAST and LOUDLY rather than waiting or, far worse,
# proceeding and corrupting the first. Taken BEFORE the cleanup trap is
# installed, so a refused run cannot touch anything.
LOCK_FILE="${X1_LOCK_FILE:-${TMPDIR:-/tmp}/x1-e2e-run.lock}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "run.sh: another X1 run already holds ${LOCK_FILE}." >&2
  echo "        The compose stack is a SERIAL resource: a second run recreates agentd with a" >&2
  echo "        new project API key and the first run's key stops working mid-flight, which" >&2
  echo "        surfaces as unrelated tests timing out. Wait for it, or kill it first." >&2
  exit 3
fi

ORANGE_PROJECT="${ORANGE_PROJECT:-agent-orange}"
WOLF_PROJECT="${WOLF_PROJECT:-agent-wolf}"
ORANGE_DIND_CONTAINER="${ORANGE_DIND_CONTAINER:-${ORANGE_PROJECT}-dind-1}"

# The two pinned ports. See note 2 in the header.
ORANGE_WEB_PORT="${ORANGE_WEB_PORT:-8090}"
WOLF_WEB_PORT="${WOLF_WEB_PORT:-8091}"
WOLF_API_PORT="${WOLF_API_PORT:-8100}"
ORANGE_BASE="http://localhost:${ORANGE_WEB_PORT}"
WOLF_BASE="http://localhost:${WOLF_WEB_PORT}"

X1_LOGIN_EMAIL="${X1_LOGIN_EMAIL:-kai@badcode.dev}"
X1_LOGIN_PASSWORD="${X1_LOGIN_PASSWORD:-x1-dev-login}"

# ── The redacted compose inspector (R82) ────────────────────────────────────
# NEVER call `docker compose config` bare: it interpolates every variable and
# prints the values. `... config | grep WOLF_API_KEY` is NOT a fix — grep prints
# the whole matching line, value included.
# The substitution fires on the variable NAME wherever it appears, so it
# redacts both the `KEY: value` mapping form and the `KEY=value` list form.
redact() {
  sed -E 's/(WOLF_API_KEY|WOLF_MCP_TOKEN|WOLF_SESSION_SECRET|WOLF_SERIES_TOKEN_SECRET|FRED_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_CLIENT_SECRET|AGENTKIT_JWT_SECRET)([^A-Za-z0-9_].*)$/\1: <redacted>/'
}

# `dcc` is the redacted `docker compose config`, kept as the named helper the
# plan's § "Executor orientation" prescribes. The two call sites below use
# `redact` directly because they must run compose through this script's own
# `orange_compose` / `wolf_compose` wrappers, which carry the environment.
dcc() { docker compose "$@" config | redact; }

log()  { printf '\n=== %s\n' "$*"; }
fail() { printf '\nrun.sh: %s\n' "$*" >&2; exit 1; }

# ── Secrets: generated per run, never printed, never committed ──────────────

SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/x1-secrets.XXXXXX")"
chmod 700 "${SECRET_DIR}"

# 🔴 STABLE ACROSS RUNS, not regenerated each time. Rotating the project API key
# every invocation is what made a second run destroy the first (see the lock
# above), and it has a quieter cost too: an operator's own `docker compose up`,
# or a run killed hard while containers are still draining, leaves credentials
# that no longer match. Generated once, reused after that, `chmod 600`, and
# gitignored. `--rotate-secrets` forces new ones.
#
# These are local test credentials for a local stack. They are never printed,
# never committed, and never leave this machine.
SECRET_FILE="${X1_SECRET_FILE:-${E2E_DIR}/.x1-secrets.env}"

gen() { openssl rand -hex 24; }

umask 077
if [ "${1:-}" = "--rotate-secrets" ]; then
  rm -f "${SECRET_FILE}"
  shift
fi
if [ ! -s "${SECRET_FILE}" ]; then
  {
    echo "# Generated by e2e/run.sh. Local test credentials; gitignored; never commit."
    echo "export WOLF_API_KEY=${WOLF_API_KEY:-$(gen)}"
    echo "export WOLF_MCP_TOKEN=${WOLF_MCP_TOKEN:-$(gen)}"
    echo "export WOLF_SESSION_SECRET=${WOLF_SESSION_SECRET:-$(gen)}"
    echo "export WOLF_SERIES_TOKEN_SECRET=${WOLF_SERIES_TOKEN_SECRET:-$(gen)}"
    echo "export AGENTKIT_JWT_SECRET=${AGENTKIT_JWT_SECRET:-$(gen)}"
  } > "${SECRET_FILE}"
fi
chmod 600 "${SECRET_FILE}"
# shellcheck source=/dev/null
. "${SECRET_FILE}"

# ── Cleanup, which must run on EVERY exit path ──────────────────────────────
#
# A failed run that leaks sessions poisons the next one: the host port pool is
# 100 and every live session holds one. So this reclaims the hypotheses THIS RUN
# created — their schedule first (a surviving schedule keeps minting tick
# sessions while we delete them), then their `hyp-<id>` session AND every
# per-tick job session dispatched for their `researcher-<id>` worker.
#
# 🔴 SCOPED BY THE RUN MANIFEST, NOT BY A PATTERN AND NOT BY "EVERYTHING IN THE
# PROJECT". See the SAFETY note in the header for why a `hyp-*` pattern is not a
# fix. Anything in the project that this run did not create is counted and
# reported so a leak is VISIBLE, and then left exactly where it is.

# One line per hypothesis id, appended by the specs as they create them
# (helpers/x1.ts `recordHypothesis`). Created empty here so that a run which
# dies before creating anything deletes nothing at all.
export X1_RUN_MANIFEST="${SECRET_DIR}/created-hypotheses"
: > "${X1_RUN_MANIFEST}"

manifest_ids() {
  [ -s "${X1_RUN_MANIFEST}" ] || return 0
  sort -u "${X1_RUN_MANIFEST}" | grep -E '^[0-9a-f]{8}$' || true
}

api() { # api <METHOD> <PATH> [BODY]  — Orange, with the project API key
  local method="$1" path="$2" body="${3:-}"
  if [ -n "${body}" ]; then
    curl -sS -X "${method}" -H "X-API-Key: ${WOLF_API_KEY}" -H 'Content-Type: application/json' \
      --data-binary "${body}" "${ORANGE_BASE}${path}"
  else
    curl -sS -X "${method}" -H "X-API-Key: ${WOLF_API_KEY}" "${ORANGE_BASE}${path}"
  fi
}

# 🔴 `?user_email=*` IS NOT OPTIONAL. `GET /agent/sessions` defaults to the
# CALLING principal's own user_email (go/httpapi/history.go:111-116), and an
# API key's synthetic email is not the one the dispatcher stamps on a job
# session — so a plain listing shows the `hyp-<id>` sessions this rig created
# and NONE of the per-tick ones. A cleanup written the obvious way therefore
# leaks a container and a host port per tick, which is exactly the leak that
# poisons the next run. Wolf's own client has always passed it
# (api/src/orange/client.ts:698-701); this rig had to learn it the hard way.
count_sessions() {
  api GET '/agent/sessions?user_email=*&limit=200' 2>/dev/null \
    | python3 -c 'import json,sys
try:
    rows = json.load(sys.stdin)
except Exception:
    print("?"); raise SystemExit(0)
print(len(rows) if isinstance(rows, list) else "?")'
}

# Session ids belonging to ONE hypothesis id: its `hyp-<id>` chat session and
# every job session the dispatcher ran for `researcher-<id>`. Matched on the
# fields Orange returns, never on a substring of a name.
list_session_ids_for() { # list_session_ids_for <hypothesis-id>
  api GET '/agent/sessions?user_email=*&limit=200' 2>/dev/null \
    | python3 -c 'import json,sys
want = sys.argv[1]
try:
    rows = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for r in rows if isinstance(rows, list) else []:
    if r.get("name") == "hyp-" + want or r.get("worker") == "researcher-" + want:
        print(r.get("id",""))' "$1" | grep -v '^$' || true
}

list_schedule_ids_for() { # list_schedule_ids_for <hypothesis-id>
  api GET '/agent/schedules?limit=200' 2>/dev/null \
    | python3 -c 'import json,sys
want = "researcher-" + sys.argv[1]
try:
    doc = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
rows = doc.get("schedules", doc) if isinstance(doc, dict) else doc
for r in rows if isinstance(rows, list) else []:
    if r.get("worker") == want:
        print(r.get("id",""))' "$1" | grep -v '^$' || true
}

CLEANED=0
cleanup() {
  local rc=$?
  [ "${CLEANED}" = 1 ] && exit "${rc}"
  CLEANED=1
  # 🔴 401 IS NOT "ORANGE IS DOWN", AND CONFLATING THEM SILENTLY LEAKS.
  #
  # This probe used to be `curl -fsS …`, which fails on ANY non-2xx. When a
  # second run rotated the project API key (see the lock above), the probe got
  # 401, `-f` made it look like a dead stack, cleanup printed "Orange is not
  # answering; nothing to reclaim" and returned — leaking every session that run
  # had created. That is how ~35 orphaned sessions accumulated on this host,
  # each holding one of the 100 host ports, and it is exactly the "a failed run
  # that leaks sessions poisons the next one" hazard this cleanup exists to
  # prevent. The guard had a hole precisely where it mattered most.
  local probe
  probe="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "${ORANGE_BASE}/agent/sessions?user_email=*&limit=1" -H "X-API-Key: ${WOLF_API_KEY}" 2>/dev/null || echo 000)"
  if [ "${probe}" = "401" ] || [ "${probe}" = "403" ]; then
    echo "cleanup: 🔴 Orange REFUSED this run's project API key (HTTP ${probe})." >&2
    echo "cleanup: 🔴 THIS RUN'S SESSIONS ARE LEAKED and still hold host ports." >&2
    echo "cleanup:    Something recreated agentd with a different key mid-run." >&2
    echo "cleanup:    Reclaim them with:  ./e2e/run.sh --reclaim-orphans" >&2
  elif [ "${probe}" = "200" ]; then
    local before after ids hid sid n
    before="$(count_sessions)"
    ids="$(manifest_ids)"
    if [ -z "${ids}" ]; then
      log "cleanup: this run recorded creating no hypotheses — deleting NOTHING"
    else
      n="$(printf '%s\n' "${ids}" | wc -l)"
      log "cleanup: reclaiming the ${n} hypothesis/hypotheses THIS RUN created (schedule, then sessions)"
      for hid in ${ids}; do
        # Schedule first: a live schedule keeps dispatching tick sessions while
        # we delete them.
        for sid in $(list_schedule_ids_for "${hid}"); do
          api DELETE "/agent/schedules/${sid}" >/dev/null 2>&1 || true
        done
        for sid in $(list_session_ids_for "${hid}"); do
          api DELETE "/agent/session/${sid}" >/dev/null 2>&1 || true
        done
        printf 'cleanup:   %s reclaimed\n' "${hid}"
      done
    fi
    after="$(count_sessions)"
    printf 'cleanup: sessions in project wolf %s → %s\n' "${before}" "${after}"
    # 🔴 Reported, never deleted. A non-zero remainder is either state this run
    # did not create (leave it alone) or a genuine leak (fix the manifest) —
    # and it must be VISIBLE either way rather than quietly swept up.
    if [ "${after}" != "0" ] && [ "${after}" != "?" ]; then
      printf 'cleanup: %s session(s) remain that this run did not record creating — LEFT ALONE, not deleted.\n' "${after}"
      printf 'cleanup: if they are yours, they are a leak; if not, they belong to someone else.\n'
    fi
  else
    echo "cleanup: Orange is not answering; nothing to reclaim through the API"
  fi
  rm -rf "${SECRET_DIR}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# ── --down ──────────────────────────────────────────────────────────────────

# ── --reclaim-orphans ───────────────────────────────────────────────────────
#
# 🔴 EXPLICIT, NEVER AUTOMATIC, AND DESTRUCTIVE BY DESIGN. Deletes every session
# in the `wolf` project whose name is `hyp-<8 hex>` or whose worker is
# `researcher-<8 hex>` — i.e. everything an X1 run creates — regardless of which
# run created it. That is exactly the blast radius the manifest scoping exists
# to avoid, which is why it is a named command an operator types and never
# something cleanup does on its own: on a project holding REAL hypotheses this
# deletes them. Use it only on a test project after a poisoned run.
if [ "${1:-}" = "--reclaim-orphans" ]; then
  log "reclaiming EVERY X1-shaped session in project wolf (explicit, destructive)"
  before_n="$(count_sessions)"
  api GET '/agent/sessions?user_email=*&limit=500' 2>/dev/null \
    | python3 -c 'import json,re,sys
try:
    rows = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for r in rows if isinstance(rows, list) else []:
    name = r.get("name") or ""
    worker = r.get("worker") or ""
    if re.fullmatch(r"hyp-[0-9a-f]{8}", name) or re.fullmatch(r"researcher-[0-9a-f]{8}", worker):
        print(r.get("id",""))' | grep -v '^$' | while read -r sid; do
      api DELETE "/agent/session/${sid}" >/dev/null 2>&1 || true
    done
  printf 'reclaim: sessions in project wolf %s → %s\n' "${before_n}" "$(count_sessions)"
  exit 0
fi

if [ "${1:-}" = "--down" ]; then
  log "stopping both stacks"
  ( cd "${WOLF_REPO}" && docker compose -p "${WOLF_PROJECT}" down ) || true
  ( cd "${ORANGE_REPO}" && docker compose -p "${ORANGE_PROJECT}" down ) || true
  exit 0
fi

# ── The spec-name filter ────────────────────────────────────────────────────

SPEC_FILTER="${1:-}"
SPEC_ARGS=()
if [ -n "${SPEC_FILTER}" ]; then
  SPEC_PATH="${E2E_DIR}/features/${SPEC_FILTER}.spec.ts"
  [ -f "${SPEC_PATH}" ] || fail "no such spec: e2e/features/${SPEC_FILTER}.spec.ts (a filter matching nothing must not pass vacuously)"
  SPEC_ARGS=("features/${SPEC_FILTER}.spec.ts")
fi

# ── 1. Orange, in offline mock mode ─────────────────────────────────────────

export X1_MOCK_SCRIPT="${E2E_DIR}/mock/script.json"
[ -f "${X1_MOCK_SCRIPT}" ] || fail "missing ${X1_MOCK_SCRIPT}"

# The project map in O8's OBJECT form. `api_key_env` is a variable NAME, which
# is why this line carries no secret. `allowed_origins` is what the embed page's
# frame-ancestors CSP is built from — note 3 in the header.
PROJECT_MAP=$(cat <<JSON
{"users":{"${X1_LOGIN_EMAIL}":["wolf"]},"projects":{"wolf":{"api_key_env":"WOLF_API_KEY","allowed_origins":["${WOLF_BASE}"]}}}
JSON
)

orange_compose() {
  ( cd "${ORANGE_REPO}" && env \
      WEB_PORT="${ORANGE_WEB_PORT}" \
      ANTHROPIC_API_KEY= CLAUDE_CODE_OAUTH_TOKEN= \
      AGENTKIT_BLOB_BACKEND=fs AGENTKIT_REGISTRY_BACKEND=blobarchive AGENTKIT_REGISTRY_AUTH= \
      AGENTKIT_REGISTRY_ALWAYS_PULL= \
      GOOGLE_APPLICATION_CREDENTIALS= \
      BASE_IMAGE=agentkit-sandbox:dev \
      AGENTKIT_JWT_SECRET="${AGENTKIT_JWT_SECRET}" \
      AGENTKIT_PROJECT_MAP="${PROJECT_MAP}" \
      WOLF_API_KEY="${WOLF_API_KEY}" \
      WOLF_MCP_TOKEN="${WOLF_MCP_TOKEN}" \
      AGENTKIT_MCP_ENV=WOLF_MCP_TOKEN \
      X1_MOCK_SCRIPT="${X1_MOCK_SCRIPT}" \
      docker compose -p "${ORANGE_PROJECT}" \
        -f docker-compose.yml -f "${E2E_DIR}/orange-override.yml" "$@" )
}

log "starting agent-orange (web on ${ORANGE_WEB_PORT}, mock model, local fs/blobarchive backends)"
orange_compose up -d --build

# agentd reads the mock script table ONCE, at boot. The bind-mount means the
# file is live, but the process is not — so restart it whenever this rig runs,
# or a script edited since the last `up` is silently not the one in force.
log "restarting agentd so it re-reads the mock script table"
orange_compose restart agentd

# ── 2. The mock-mode assertion (no billable call) ───────────────────────────

assert_mock_mode() {
  local logs boot i

  # 🔴 WAIT FOR THE LINE BEFORE JUDGING IT. This runs immediately after
  # `restart agentd`, and the boot line is printed a moment later — so an
  # unlucky read saw an old log or an empty one. It failed CLOSED (no line →
  # abort), which is the safe direction, but a rig that aborts intermittently
  # gets re-run rather than believed, and the next reflex is to weaken the
  # assertion. Bounded, and the timeout is itself a failure.
  for i in $(seq 1 60); do
    logs="$(orange_compose logs agentd 2>&1)"
    printf '%s\n' "${logs}" | grep -qF 'ANTHROPIC_API_KEY unset → SCRIPTED mock model proxy' && break
    printf '%s\n' "${logs}" | grep -qF 'real model proxy →' && break
    printf '%s\n' "${logs}" | grep -qF 'subscription mode →' && break
    [ "${i}" = 60 ] && fail "agentd printed no model-proxy line within 60s of restarting — refusing to run anything that could be billable"
    sleep 1
  done

  # ONE command per factual claim (R231): each grep below stands alone and its
  # message names the command that actually ran.
  boot="$(printf '%s\n' "${logs}" | grep -F 'ANTHROPIC_API_KEY unset → SCRIPTED mock model proxy' | tail -1 || true)"
  if [ -z "${boot}" ]; then
    printf '%s\n' "${logs}" | tail -40 >&2
    fail "agentd did not print the SCRIPTED mock-model boot line — refusing to run anything that could be billable"
  fi
  printf 'mock-mode proof (agentd boot log): %s\n' "${boot#*| }"

  if printf '%s\n' "${logs}" | grep -qF 'real model proxy →'; then
    fail "agentd logged 'real model proxy' — a BILLABLE model is configured. Aborting."
  fi
  if printf '%s\n' "${logs}" | grep -qF 'subscription mode →'; then
    fail "agentd logged 'subscription mode' — CLAUDE_CODE_OAUTH_TOKEN reached the container. Aborting."
  fi
  echo "no 'real model proxy' line; no 'subscription mode' line — nothing in this run can bill."
}

log "asserting agentd chose a mock model"
assert_mock_mode

# ── 3. Wait for Orange's API ────────────────────────────────────────────────

wait_for() { # wait_for <label> <seconds> <command...>
  local label="$1" secs="$2"; shift 2
  local i=0
  until "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "${i}" -ge "${secs}" ] && fail "timed out after ${secs}s waiting for ${label}"
    sleep 1
  done
  echo "up: ${label}"
}

wait_for "orange /agent/sessions" 120 \
  curl -fsS -o /dev/null -H "X-API-Key: ${WOLF_API_KEY}" "${ORANGE_BASE}/agent/sessions"

SESSIONS_BEFORE="$(count_sessions)"
printf 'sessions in project wolf BEFORE the run: %s\n' "${SESSIONS_BEFORE}"

# ── 4. The Wolf session image, built INSIDE DinD ────────────────────────────

log "building the wolf session image inside DinD (a host-built image is invisible to sessions)"
ORANGE_REPO="${ORANGE_REPO}" ORANGE_DIND_CONTAINER="${ORANGE_DIND_CONTAINER}" \
  "${WOLF_REPO}/scripts/load-image-into-dind.sh"

# ── 5. Wolf ─────────────────────────────────────────────────────────────────

# DinD's INNER docker0 address — the one a nested session container reaches
# agentd and wolf-api on. See note 4 in the header for why the boot probe's
# answer is the wrong one.
dind_gateway() {
  docker exec "${ORANGE_DIND_CONTAINER}" ip -4 -o addr show docker0 \
    | awk '{print $4}' | cut -d/ -f1 | head -1
}

GATEWAY="$(dind_gateway)"
[ -n "${GATEWAY}" ] || fail "could not read docker0's address inside ${ORANGE_DIND_CONTAINER}"
printf 'DinD inner docker0 gateway: %s (sessions reach agentd at %s:8099 and wolf-api at %s:%s)\n' \
  "${GATEWAY}" "${GATEWAY}" "${GATEWAY}" "${WOLF_API_PORT}"

WOLF_MCP_URL="http://${GATEWAY}:${WOLF_API_PORT}/mcp"

wolf_compose() {
  ( cd "${WOLF_REPO}" && env \
      WOLF_WEB_PORT="${WOLF_WEB_PORT}" \
      WOLF_API_PORT="${WOLF_API_PORT}" \
      ORANGE_DIND_CONTAINER="${ORANGE_DIND_CONTAINER}" \
      ORANGE_BASE_URL=http://localhost:8099 \
      ORANGE_PUBLIC_URL="${ORANGE_BASE}" \
      VITE_ORANGE_PUBLIC_URL="${ORANGE_BASE}" \
      WOLF_MCP_URL="${WOLF_MCP_URL}" \
      WOLF_API_KEY="${WOLF_API_KEY}" \
      WOLF_MCP_TOKEN="${WOLF_MCP_TOKEN}" \
      `# 🔴 THE OFFLINE GUARANTEE, AND IT HAS TO BE HERE. Compose reads a .env` \
      `# from the PROJECT DIRECTORY, and the canonical agent-wolf checkout has` \
      `# one holding a real FRED_API_KEY. Left alone, wolf-api boots with that` \
      `# key and the tick's mcp__wolf__series_fetch makes a LIVE, CREDENTIALED` \
      `# call to api.stlouisfed.org — in a suite whose first acceptance` \
      `# criterion is "runs offline". This rig was offline only by ACCIDENT of` \
      `# being run from a worktree that had no .env. Blanked explicitly, the` \
      `# same way the model credentials are, and asserted below.` \
      FRED_API_KEY= \
      WOLF_SESSION_SECRET="${WOLF_SESSION_SECRET}" \
      WOLF_SERIES_TOKEN_SECRET="${WOLF_SERIES_TOKEN_SECRET}" \
      WOLF_ALLOWED_EMAILS="${X1_LOGIN_EMAIL}" \
      WOLF_TEST_LOGIN="${X1_LOGIN_EMAIL}:${X1_LOGIN_PASSWORD}" \
      WOLF_SCHEDULE_CRON='* * * * *' \
      WOLF_POLL_INTERVAL_SECONDS=15 \
      WOLF_TEARDOWN_DRAIN_SECONDS=5 \
      WOLF_BASE_IMAGE=agent-wolf:dev \
      NODE_ENV=development \
      LOG_LEVEL=info \
      docker compose -p "${WOLF_PROJECT}" "$@" )
}

log "starting agent-wolf (web on ${WOLF_WEB_PORT}, schedule cron '* * * * *' — there is no force-fire route)"
wolf_compose up -d --build
# The environment above changes between runs (a fresh WOLF_API_KEY each time),
# so `up -d` recreates wolf-api on its own; wolf-web is a BUILT bundle and is
# rebuilt by --build whenever VITE_ORANGE_PUBLIC_URL changes.

wait_for "wolf-web /api/auth/me" 120 \
  bash -c "test \"\$(curl -s -o /dev/null -w '%{http_code}' '${WOLF_BASE}/api/auth/me')\" = 401"

# 🔴 NO UPSTREAM CREDENTIAL REACHED wolf-api. Measured inside the container, by
# LENGTH — the value is never read, never printed, never compared. An
# environment invariant belongs here, where it can be checked once and fail the
# run, not inside a spec assertion that would fail three minutes later and blame
# the wrong thing.
fred_len="$(docker compose -p "${WOLF_PROJECT}" exec -T wolf-api sh -c 'printf "%s" "${#FRED_API_KEY}"' 2>/dev/null || echo unknown)"
if [ "${fred_len}" != "0" ]; then
  fail "wolf-api booted with a FRED_API_KEY of length ${fred_len} — this run would make a LIVE, CREDENTIALED call to api.stlouisfed.org. Refusing. (A .env in the agent-wolf checkout is the usual source; run.sh blanks it, so this means the blanking did not take.)"
fi
echo "offline proof: FRED_API_KEY inside wolf-api has length 0 — no live market-data call is possible."

# ── 5b. What the two stacks were actually configured with ───────────────────
#
# 🔴 THROUGH `dcc`, ALWAYS. A bare `docker compose config` interpolates every
# variable and prints WOLF_API_KEY, WOLF_MCP_TOKEN and friends to stdout (R82),
# and `... config | grep WOLF_API_KEY` is not a fix — grep prints the whole
# matching line, value included.
#
# ⚠️ AND THIS PROVES A DECLARATION, NOT A BEHAVIOUR (R41). W1's nginx bug
# survived a pass that looked exactly like this block. It is here so a failed
# run leaves a record of what it was configured with; every claim about what
# WORKS is made by a spec that exercised it.
log "the two stacks' resolved configuration (secrets redacted — R82)"
{
  echo "--- agent-orange/agentd ---"
  orange_compose config 2>/dev/null | redact \
    | grep -E '^ +(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|AGENTKIT_MCP_ENV|AGENTKIT_MOCK_MODEL_SCRIPT_FILE|AGENTKIT_BLOB_BACKEND|AGENTKIT_REGISTRY_BACKEND|AGENTKIT_SELF_URL|WOLF_API_KEY|WOLF_MCP_TOKEN):'
  echo "--- agent-wolf ---"
  wolf_compose config 2>/dev/null | redact \
    | grep -E '^ +(WOLF_API_KEY|WOLF_MCP_TOKEN|WOLF_MCP_URL|WOLF_SCHEDULE_CRON|WOLF_POLL_INTERVAL_SECONDS|WOLF_BASE_IMAGE|ORANGE_PUBLIC_URL|VITE_ORANGE_PUBLIC_URL):'
} || true

# ── 6. Bootstrap the `wolf` project ─────────────────────────────────────────
# Idempotent by construction (W12); run every time so a fresh database is
# seeded and an existing one is left alone.

log "bootstrapping the wolf project (settings, interviewer, critic, critic schedule)"
( cd "${WOLF_REPO}" && env \
    ORANGE_BASE_URL="${ORANGE_BASE}" \
    WOLF_API_KEY="${WOLF_API_KEY}" \
    WOLF_MCP_TOKEN="${WOLF_MCP_TOKEN}" \
    WOLF_MCP_URL="${WOLF_MCP_URL}" \
    WOLF_SESSION_SECRET="${WOLF_SESSION_SECRET}" \
    WOLF_ALLOWED_EMAILS="${X1_LOGIN_EMAIL}" \
    WOLF_BASE_IMAGE=agent-wolf:dev \
    WOLF_SCHEDULE_CRON='* * * * *' \
    npx --yes tsx scripts/bootstrap-project.ts )

# ── 7. The specs ────────────────────────────────────────────────────────────

log "installing e2e dependencies"
( cd "${E2E_DIR}" && npm install --no-audit --no-fund --silent )
# Playwright pins a browser BUILD, not just a version: a machine that already
# has some chromium under ~/.cache/ms-playwright still fails with "Executable
# doesn't exist at …/chromium_headless_shell-<n>/…" when the installed
# @playwright/test wants a different <n>. Idempotent, and a no-op once the
# right build is present.
( cd "${E2E_DIR}" && npx playwright install chromium )

log "running playwright${SPEC_FILTER:+ (filter: ${SPEC_FILTER})}"
set +e
( cd "${E2E_DIR}" && env \
    X1_WOLF_BASE="${WOLF_BASE}" \
    X1_ORANGE_BASE="${ORANGE_BASE}" \
    X1_ORANGE_PROJECT="${ORANGE_PROJECT}" \
    X1_DIND_CONTAINER="${ORANGE_DIND_CONTAINER}" \
    X1_LOGIN_EMAIL="${X1_LOGIN_EMAIL}" \
    X1_LOGIN_PASSWORD="${X1_LOGIN_PASSWORD}" \
    X1_RUN_MANIFEST="${X1_RUN_MANIFEST}" \
    WOLF_API_KEY="${WOLF_API_KEY}" \
    npx playwright test "${SPEC_ARGS[@]}" )
RC=$?
set -e

printf '\nplaywright exit code: %s\n' "${RC}"
printf 'sessions in project wolf BEFORE the run: %s\n' "${SESSIONS_BEFORE}"
printf 'sessions in project wolf AFTER the specs (before cleanup): %s\n' "$(count_sessions)"

exit "${RC}"
