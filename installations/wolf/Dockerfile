# wolf — Agent Wolf's session base image.
#
# Extends agent-orange's "core" installation with the Python data stack the
# daily researcher needs to normalise market-data CSVs and do local
# aggregation (pandas, numpy) and larger-than-memory work over the CSVs it
# pulls (duckdb). Nothing else.
#
# Do NOT set CMD / ENTRYPOINT / EXPOSE / HEALTHCHECK / WORKDIR — owned by the
# sandbox base image (see agent-orange's installations/README.md; WORKDIR
# joined that list on 2026-08-13 after setting it broke every session
# launched from "core"). This file only adds a runtime layer.
#
# This image is built INSIDE Agent Orange's DinD daemon, not on the host —
# see ../../scripts/load-image-into-dind.sh, and do not `docker build` this
# directly against your host Docker if you expect sessions to see the
# result: with the default `blobarchive` registry, `EnsurePresent` is a
# no-op locally, so a host-built image is invisible to agentd.
#
# Build (via the loader script, from the agent-wolf repo root):
#   ./scripts/load-image-into-dind.sh
#
# Or, equivalently, by hand once agent-orange-core:dev already exists in
# DinD:
#   docker build -f installations/wolf/Dockerfile \
#     --build-arg BASE_IMAGE=agent-orange-core:dev \
#     -t agent-wolf:dev installations/wolf
ARG BASE_IMAGE=agent-orange-core:dev
FROM ${BASE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages \
      pandas numpy duckdb
