# Swipe server + web app. Build: docker build -t swipe .   Run: docker run -p 8080:8080 swipe
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN npm ci --omit=dev --prefix server && npm cache clean --force
COPY server/src server/src
COPY web web
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/src/server.js"]
