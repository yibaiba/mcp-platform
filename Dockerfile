# Python 3.13.9 and uv 0.9.5, pinned multi-architecture image index.
FROM ghcr.io/astral-sh/uv:0.9.5-python3.13-bookworm-slim@sha256:60d8ee2c1f7ffce050822adcb44907514e39f29d2d7b37732e8fca9f4f6113af AS python
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
RUN pnpm check-types \
    && node scripts/check.mjs 60 pnpm exec vitest run tests/web.test.ts \
    && pnpm build

FROM build AS app
COPY --from=python /usr/local/ /usr/local/
COPY --from=connector-build /app/connector/bin /app/connector/bin
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libexpat1 libsqlite3-0 libbz2-1.0 libffi8 liblzma5 libncursesw6 libreadline8 libuuid1 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && python -c 'import sys; assert sys.version_info[:3] == (3, 13, 9)' \
    && uv --version && uvx --version \
    && mkdir -p /app/.data/python/cache /app/.data/python/tools /app/.data/python/bin \
    && chown -R node:node /app/.data
ENV NODE_ENV=production
ENV UV_CACHE_DIR=/app/.data/python/cache \
    UV_TOOL_DIR=/app/.data/python/tools \
    UV_TOOL_BIN_DIR=/app/.data/python/bin \
    UV_PYTHON=/usr/local/bin/python3.13 \
    UV_PYTHON_DOWNLOADS=never \
    PATH=/app/.data/python/bin:$PATH
LABEL org.opencontainers.image.source="https://github.com/yibaiba/mcp-platform"
USER node
EXPOSE 4300
CMD ["pnpm", "start"]
