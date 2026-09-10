#!/usr/bin/env bash
#
# publish-image.sh — build Agent Wolf's session image and push it to YOUR
# container registry, so agentd PULLS it exactly as production does.
#
#   REGISTRY=<host>/<project>/<repo> ./scripts/publish-image.sh [tag]
#
# ── Why this exists alongside load-image-into-dind.sh ────────────────────────
#
# There are two ways to get `installations/wolf` in front of a session, and they
# are not interchangeable:
#
#   load-image-into-dind.sh   builds INSIDE Agent Bob's DinD daemon, FROM a
#                             local `agent-bob-core:dev`. Works offline,
#                             needs no registry credential — and is the LOCAL
#                             path, not production's. It also only works when
#                             agent-bob's stack was started in `local` image
#                             mode: registry mode never builds
#                             `agentkit-sandbox:dev` into DinD, so the core
#                             image that script builds FROM does not exist.
#
#   THIS script              builds on the HOST, FROM the published
#                             `session-core:<tag>`, and pushes the result as
#                             `session-wolf:<tag>`. agentd then pulls it with
#                             ADC through the `ociregistry` backend — the same
#                             code path, the same credential and the same image
#                             reference production uses. Point WOLF_BASE_IMAGE
#                             at the ref this prints and local stops diverging
#                             from deployed.
#
# Run agent-bob's `./stack publish-base <tag>` first: this builds FROM
# session-core, so that tag has to exist in the registry before this can work.
#
# Do NOT set agent-bob's own compose BASE_IMAGE to this image. That variable
# is the *harness* base; agent-bob's init-sandbox rebuilds the bare harness
# and tags it with any BASE_IMAGE containing no "/", which would silently
# overwrite whatever shares the tag. WOLF_BASE_IMAGE is a different thing — a
# per-project setting Wolf's bootstrap writes into the `wolf` project's
# settings row, and it never touches agent-bob's BASE_IMAGE.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${REGISTRY:?set REGISTRY, e.g. REGISTRY=europe-west1-docker.pkg.dev/webkit-servers/agent-bob}"

TAG="${1:-dev}"
CORE_REF="$REGISTRY/session-core:$TAG"
WOLF_REF="$REGISTRY/session-wolf:$TAG"

# ── Preflight: the credential helper ─────────────────────────────────────────
# Being logged into gcloud is NOT enough — Docker resolves credentials per
# registry HOST, and an Artifact Registry host is a separate config entry from
# the old gcr.io ones. A machine with gcr.io configured and not
# europe-west1-docker.pkg.dev fails with "no basic auth credentials", which
# reads like a network fault and is not. Checked before the multi-minute build,
# not after. (Same preflight as agent-bob's deploy/publish-base.sh.)
host="${REGISTRY%%/*}"
case "$host" in
  *-docker.pkg.dev|gcr.io|*.gcr.io)
    if ! grep -q "\"$host\"" "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null; then
      echo "!! Docker has no credential helper for $host." >&2
      echo "!! Run this once, then try again:" >&2
      echo "!!   gcloud auth configure-docker $host" >&2
      exit 1
    fi
    ;;
esac

# ── Build FROM the published core, not from whatever is cached ───────────────
# An explicit pull, so this image is provably a layer on the bytes that are in
# the registry now. Without it a stale local `session-core:dev` — the tag drifts
# by design — silently becomes the base, and the session image you push is a
# layer on something nobody can identify.
echo "── pulling $CORE_REF (the published base — never build on a cached :dev) ──"
docker pull "$CORE_REF"

echo "── building $WOLF_REF ──"
docker build -f installations/wolf/Dockerfile \
  --build-arg BASE_IMAGE="$CORE_REF" \
  -t "$WOLF_REF" installations/wolf

# ── Smoke test before pushing ────────────────────────────────────────────────
# The whole point of this image over session-core is the Python data stack. A
# push of an image that cannot import it is a broken session an hour later,
# blamed on the researcher prompt. `docker run` overrides the base's CMD, which
# is fine and deliberate — we are testing the layer, not booting the harness.
echo "── smoke test: import pandas, numpy, duckdb ──"
docker run --rm "$WOLF_REF" python3 -c "import pandas, numpy, duckdb"

echo "── pushing ──"
docker push "$WOLF_REF"

digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$WOLF_REF" 2>/dev/null || true)"

cat <<EOF

── published ──────────────────────────────────────────────────────────────────
  $WOLF_REF
${digest:+  digest: $digest}

Point Wolf's sessions at it:

  WOLF_BASE_IMAGE=$WOLF_REF

agent-bob's ./stack wolf up does that for you. Setting it by hand means
re-running the bootstrap so the "wolf" project's settings row picks it up:

  ./stack wolf bootstrap
EOF
