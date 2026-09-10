# Build context: repo root (docker-compose.yml build.context: .) — needs the
# workspace root package.json/yarn.lock plus web/. Also needs
# tools/import-boundary: a third yarn workspace (see root package.json's
# `workspaces` array) that web/'s own import-boundary test imports as
# "@wolf/import-boundary" — `yarn install` resolves it via workspace
# symlink, so both its package.json (for install) and its real source (for
# `tsc -p tsconfig.json`, which typechecks every file under web/src/,
# including *.test.ts) must be present in this build stage, same as web/'s
# own two-step copy below.
FROM node:20-slim AS build
WORKDIR /src
COPY package.json yarn.lock ./
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
COPY tools/import-boundary/package.json ./tools/import-boundary/package.json
# The vendored @agentkit/chat-ui tarball, which web/package.json depends on as
# `file:./vendor/agentkit-chat-ui-<version>.tgz`. It must be present BEFORE
# `yarn install`, not with the rest of web/ below, or the install fails with
# `Tarball is not in network and can not be located in cache`.
#
# 🔴 Added by W13. W28 introduced the vendored dependency and did not update
# this file, so `docker build -f web/Dockerfile .` had been failing at this
# step ever since — the unit tests and `yarn build` both run against the
# already-installed workspace and cannot see it. That is the whole reason
# W13's Validation builds the image and greps the served bundle rather than
# reading a config.
COPY web/vendor ./web/vendor
RUN corepack enable && yarn install --frozen-lockfile
COPY web ./web
COPY tools/import-boundary ./tools/import-boundary
COPY tsconfig.base.json ./tsconfig.base.json

# The two BROWSER-side variables. `wolf-web` ships as a built nginx image and
# cannot read runtime environment, so these have to be baked in HERE: vite
# replaces every `import.meta.env.VITE_*` with a string literal at build time,
# and by the time nginx serves the bundle there is nothing left to configure.
# They are read in exactly one source file, web/src/env.ts.
#
# ARG alone is not enough — vite reads the ENVIRONMENT, not the build args —
# so each ARG is promoted to an ENV, and both sit BEFORE `yarn build`.
#
# ⚠️ VITE_BOB_PUBLIC_URL must be the same origin as wolf-api's
# BOB_PUBLIC_URL, and it must appear in the `wolf` project's
# `allowed_origins` in Orange's project map: the embed page's
# `frame-ancestors` CSP is built from that list, so a mismatch means the
# browser blocks the chat rail outright with no error on the Wolf side.
ARG VITE_BOB_PUBLIC_URL=http://localhost:8080
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_BOB_PUBLIC_URL=$VITE_BOB_PUBLIC_URL
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

WORKDIR /src/web
RUN yarn build

FROM nginx:1.27-alpine
# `default.conf.template` is env-substituted by the base image's
# docker-entrypoint.d at container start (it envsubst's every
# /etc/nginx/templates/*.template into /etc/nginx/conf.d/*.conf), which is
# how WOLF_API_PORT reaches a static nginx config — see the comment in the
# template itself.
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/web/dist /usr/share/nginx/html
EXPOSE 80
