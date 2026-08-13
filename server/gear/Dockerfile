# The shared gear service. No dependencies, so no install step and no
# lockfile to drift: the whole thing is one file on the stock node image.
FROM node:20-alpine

WORKDIR /app
COPY server.js ./

# Runs unprivileged. It only ever writes to /data, which compose mounts.
RUN mkdir -p /data && chown -R node:node /data
USER node

ENV PORT=8080 \
    GEAR_DATA=/data/gear.json
EXPOSE 8080

# The service reads its own storage on /health, so an unhealthy container means
# the volume is wrong rather than merely that the process died.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
