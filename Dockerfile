# syntax=docker/dockerfile:1
# Multi-stage build for the MRDT Software Bible (Docusaurus).
#   target=dev   → hot-reload dev server (default for `docker compose up`)
#   target=prod  → static build served by nginx

# ---- shared deps layer ----
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
# npm 10 can print "Exit handler never called!" and still exit 0 when it cannot
# reach the registry — every download fails with EAI_AGAIN, node_modules ends up
# without its .bin symlinks, and Docker happily caches the broken layer. The
# failure then surfaces much later as "sh: docusaurus: not found" during
# `npm run build`. Verify the install instead of trusting the exit code.
RUN set -eu; \
    npm ci --no-audit --no-fund; \
    if [ ! -x node_modules/.bin/docusaurus ]; then \
      echo "-------------------------------------------------------------------"; \
      echo "npm ci exited 0 but produced no usable install:"; \
      echo "  node_modules/.bin/docusaurus is missing"; \
      echo; \
      echo "Almost always this is DNS inside the build sandbox. BuildKit drops"; \
      echo "loopback nameservers from the host's /etc/resolv.conf, so a host"; \
      echo "resolving via 127.0.0.1 leaves the build with no working resolver."; \
      echo "Confirm with:  docker build --no-cache --target base ."; \
      echo "Work around:   docker compose build --network=host"; \
      echo "Fix properly:  add \"dns\": [\"8.8.8.8\", \"1.1.1.1\"] to"; \
      echo "               /etc/docker/daemon.json and restart docker"; \
      echo "-------------------------------------------------------------------"; \
      exit 1; \
    fi

# ---- dev: live-editing server with hot reload ----
FROM base AS dev
ENV CHOKIDAR_USEPOLLING=true
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start", "--", "--host", "0.0.0.0", "--poll", "1000"]

# ---- build: produce the static site ----
FROM base AS build
COPY . .
RUN npm run build

# ---- prod: serve the static site with nginx ----
FROM nginx:alpine AS prod
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
