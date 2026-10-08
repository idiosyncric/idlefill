# idlefill server — the arbiter container.
# Phase 1 builds + runs this; phase 2 (deploy/) runs it under compose without
# published ports, fronted by traefik.
#
# Multi-stage: the build stage installs dev deps to run tsc; the runtime stage
# is prod-deps only and runs as a non-root user.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# The served dashboard: the React workspace's committed built output
# (cutover 2026-10-08). server/src/index.ts dashboardDir() resolves
# /app/dashboard/dist from the entry dir; ../public (the retired legacy
# page) stays as the fail-safe if the dist is ever missing.
COPY dashboard/dist/ ./dashboard/dist/
COPY public/ ./public/

# Non-root runtime user. State lives in /data (compose mounts a volume there
# in phase 2; for a bare phase-1 `docker run` the container-local /data is
# writable by appuser).
RUN addgroup -g 10001 appgroup && adduser -u 10001 -G appgroup -D appuser \
  && mkdir -p /data && chown appuser:appgroup /data
USER appuser
ENV IDLEFILL_STATE=/data/state.json
# EXPOSE is documentation only — phase 2 publishes nothing; traefik fronts it.
EXPOSE 8787
CMD ["node", "dist/index.js"]
