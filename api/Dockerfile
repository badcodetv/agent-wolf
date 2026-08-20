# Build context: repo root (docker-compose.yml build.context: .) — needs the
# workspace root package.json/yarn.lock plus api/.
FROM node:20-slim AS build
WORKDIR /src
COPY package.json yarn.lock ./
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
RUN corepack enable && yarn install --frozen-lockfile
COPY api ./api
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
