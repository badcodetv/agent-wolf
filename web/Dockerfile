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
RUN corepack enable && yarn install --frozen-lockfile
COPY web ./web
COPY tools/import-boundary ./tools/import-boundary
COPY tsconfig.base.json ./tsconfig.base.json
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
