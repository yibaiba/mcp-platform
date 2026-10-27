FROM node:24-bookworm-slim AS build
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
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/.data && chown node:node /app/.data
ENV NODE_ENV=production
USER node
EXPOSE 4300 4302
CMD ["pnpm", "start"]
