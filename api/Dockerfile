# Build context: repo root (docker-compose.yml build.context: .) — needs the
# workspace root package.json/yarn.lock plus api/. Also needs
# tools/import-boundary: a third yarn workspace (see root package.json's
# `workspaces` array) that api/'s own import-boundary test imports as
# "@wolf/import-boundary" — `yarn install` resolves it via workspace
# symlink, so both its package.json (for install) and its real source (for
# `tsc -p tsconfig.json`, which also compiles *.test.ts under api/src/ — see
# api/tsconfig.json's comment) must be present in this build stage, same as
# api/'s own two-step copy below.
FROM node:20-slim AS build
WORKDIR /src
COPY package.json yarn.lock ./
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
COPY tools/import-boundary/package.json ./tools/import-boundary/package.json
# The vendored @agentkit/chat-ui tarball. This image builds no UI and imports
# none of it — but `yarn install` at the WORKSPACE ROOT resolves every
# workspace's dependencies, and web/package.json depends on
# `file:./vendor/agentkit-chat-ui-<version>.tgz`. Without the file present,
# the install dies with `Tarball is not in network and can not be located in
# cache`, so wolf-api's image cannot be built at all.
#
# 🔴 Found by X1, the first ticket to build these images. W28 introduced the
# vendored dependency; W13/R137 added this same line to web/Dockerfile and
# nobody carried it here, so `docker compose build wolf-api` has been broken
# ever since. Neither `yarn typecheck` nor `yarn test` can see it: both run
# against the workspace that is already installed on the host.
COPY web/vendor ./web/vendor
RUN corepack enable && yarn install --frozen-lockfile
COPY api ./api
COPY tools/import-boundary ./tools/import-boundary
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /src/api
RUN yarn build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/api/dist ./dist
COPY --from=build /src/api/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
# 🔴 The four prompt files, at the ABSOLUTE path the code resolves to. W9 reads
# `researcher-preamble.md` and `researcher-method.md` at go-live through
#     new URL("../../../prompts/<name>", import.meta.url)
# (api/src/hypothesis/provision.ts:341-344). In the repo that walks
# api/src/hypothesis → api/src → api → repo root. In THIS image the module is
# /app/dist/hypothesis/provision.js, so the same three steps land on `/prompts`,
# not on /app/prompts — which is why this copies to the filesystem root rather
# than into the working directory.
#
# Found by X1. Without it every `POST /api/hypotheses/:id/go-live` answers
# 500 `internal` with `ENOENT: no such file or directory,
# open '/prompts/researcher-preamble.md'` — i.e. NO hypothesis can be launched
# in the shipped container, while `yarn test` passes because every unit test
# runs from the source tree where the relative path resolves.
#
# ⚠️ CAVEAT, LOGGED RATHER THAN FIXED HERE. This line encodes a COINCIDENCE:
# both layouts happen to sit three directories from different roots. Add or
# remove one directory level under `dist/` and the prompts silently move, every
# go-live 500s again, and no unit test notices — because they never resolve this
# path at all. The principled fix is an explicit prompts root (an env var, or a
# path resolved from the package root rather than counted upward), and it
# belongs to whoever owns `provision.ts`, not to X1. Until then
# `e2e/features/hypothesis-lifecycle.spec.ts`'s go-live step is the gate that
# catches it.
COPY prompts /prompts
CMD ["node", "dist/index.js"]
