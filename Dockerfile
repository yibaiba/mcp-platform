FROM node:24-bookworm-slim AS node-base

FROM golang:1.25-bookworm AS connector-build
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY connector/go.mod connector/go.sum ./connector/
RUN cd connector && go mod download
COPY connector ./connector
COPY scripts/build-connector.mjs ./scripts/build-connector.mjs
COPY packages/contracts/src/connectorDistribution.ts ./packages/contracts/src/connectorDistribution.ts
RUN node scripts/build-connector.mjs

FROM node-base AS build
WORKDIR /app
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm check-types && pnpm build

FROM caddy:2.10-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile

FROM build AS server
COPY --from=connector-build /app/connector/bin /app/connector/bin
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/.data && chown node:node /app/.data
ENV NODE_ENV=production
USER node
EXPOSE 4300 4302
CMD ["pnpm", "start"]
