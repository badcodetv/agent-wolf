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
CMD ["node", "dist/index.js"]
