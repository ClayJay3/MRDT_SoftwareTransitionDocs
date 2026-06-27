# syntax=docker/dockerfile:1
# Multi-stage build for the MRDT Software Bible (Docusaurus).
#   target=dev   → hot-reload dev server (default for `docker compose up`)
#   target=prod  → static build served by nginx

# ---- shared deps layer ----
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

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
