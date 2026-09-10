#!/usr/bin/env bash
#
# load-image-into-dind.sh — builds installations/wolf INSIDE Agent Bob's
# DinD daemon and smoke-tests the result.
#
# Why inside DinD, not on the host: agentd's default local registry backend
# (`blobarchive`) makes `EnsurePresent` a no-op, so a session only ever sees
# an image that is already present in the DinD daemon agentd itself talks
# to — a host-built image is invisible to it (see agent-bob's
# installations/README.md § "Local"). This script therefore streams the
# build context to DinD over `docker exec`, the same way you would build
# directly against a remote daemon.
#
# Usage (from the agent-wolf repo root, with Agent Bob's stack up):
#   ./scripts/load-image-into-dind.sh
#
# Env vars (all optional):
#   BOB_DIND_CONTAINER  Name of Agent Bob's dind container.
#                           Default: agent-bob-dind-1 (matches compose's
#                           default project-name + service-name convention
#                           for a repo checked out as "agent-bob").
#   BOB_REPO             Path to a checkout of the agent-bob repo, used
#                           only to find installations/core when
#                           agent-bob-core:dev is not already in DinD.
#                           Default: ../agent-bob (a sibling checkout).
#   WOLF_IMAGE_TAG          Tag to build this image as. Default: agent-wolf:dev
#                           — the same tag WOLF_BASE_IMAGE defaults to.
#
# ⚠️ Never set Agent Bob's compose BASE_IMAGE to this tag (agent-wolf:dev
# or whatever WOLF_IMAGE_TAG is). init-sandbox rebuilds the BARE sandbox
# harness and tags it with any BASE_IMAGE containing no "/"
# (docker-compose.yml:36-58 in agent-bob) — it would silently overwrite
# this image with the bare harness under the same tag, and every session
# would start from something that is not what this script built, with no
# error anywhere. WOLF_BASE_IMAGE (in agent-wolf's own .env) is a project
# setting Wolf's bootstrap writes into Orange's project-settings row for the
# "wolf" project specifically — it never touches Orange's own BASE_IMAGE.

set -euo pipefail

BOB_DIND_CONTAINER="${BOB_DIND_CONTAINER:-agent-bob-dind-1}"
BOB_REPO="${BOB_REPO:-../agent-bob}"
WOLF_IMAGE_TAG="${WOLF_IMAGE_TAG:-agent-wolf:dev}"
CORE_IMAGE_TAG="agent-bob-core:dev"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WOLF_INSTALLATION_DIR="${REPO_ROOT}/installations/wolf"

echo "load-image-into-dind: target container = ${BOB_DIND_CONTAINER}"

if ! docker exec "${BOB_DIND_CONTAINER}" docker image inspect "${CORE_IMAGE_TAG}" >/dev/null 2>&1; then
  CORE_DIR="${BOB_REPO}/installations/core"
  if [ ! -d "${CORE_DIR}" ]; then
    echo "error: ${CORE_IMAGE_TAG} is not present in DinD, and ${CORE_DIR} does not exist to build it from." >&2
    echo "       Check out agent-bob as a sibling of this repo (../agent-bob), or set" >&2
    echo "       BOB_REPO to point at your checkout, then re-run:" >&2
    echo "         BOB_REPO=/path/to/agent-bob ./scripts/load-image-into-dind.sh" >&2
    exit 1
  fi
  echo "load-image-into-dind: ${CORE_IMAGE_TAG} not found in DinD — building it from ${CORE_DIR}"
  tar -C "${CORE_DIR}" -cf - . | docker exec -i "${BOB_DIND_CONTAINER}" \
    docker build --build-arg BASE_IMAGE=agentkit-sandbox:dev -t "${CORE_IMAGE_TAG}" -
else
  echo "load-image-into-dind: ${CORE_IMAGE_TAG} already present in DinD — not rebuilding"
fi

echo "load-image-into-dind: building ${WOLF_IMAGE_TAG} from ${WOLF_INSTALLATION_DIR}"
tar -C "${WOLF_INSTALLATION_DIR}" -cf - . | docker exec -i "${BOB_DIND_CONTAINER}" \
  docker build --build-arg BASE_IMAGE="${CORE_IMAGE_TAG}" -t "${WOLF_IMAGE_TAG}" -

echo "load-image-into-dind: smoke-testing ${WOLF_IMAGE_TAG} (import pandas, numpy, duckdb)"
docker exec "${BOB_DIND_CONTAINER}" docker run --rm "${WOLF_IMAGE_TAG}" \
  python3 -c "import pandas, numpy, duckdb"

echo "load-image-into-dind: OK — ${WOLF_IMAGE_TAG} built and import pandas, numpy, duckdb succeeded"
