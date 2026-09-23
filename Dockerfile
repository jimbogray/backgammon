FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
# Build identifier (the git commit in CI), reported by /healthz.
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    PORT=3000 \
    DATABASE_PATH=/data/backgammon.db
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]
