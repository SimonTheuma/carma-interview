# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npx next build
RUN npx esbuild src/cli/migrate.ts src/cli/load.ts src/worker/index.ts \
  --bundle --platform=node --target=node22 --format=cjs \
  --outbase=src --outdir=dist --packages=external \
  && cp dist/worker/index.js dist/worker.js

FROM node:22.14.0-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R node:node /app
USER node
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/db/migrations ./db/migrations
COPY --from=build --chown=node:node /app/data ./data
EXPOSE 3000 9101
CMD ["node", "server.js"]

FROM deps AS test
WORKDIR /app
COPY . .
ENV NODE_ENV=test
CMD ["npm", "test"]
