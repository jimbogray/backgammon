# The API only. The web app is built separately and served by Azure Static Web Apps.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.server.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
RUN npm run build:api && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
# Build identifier (the git commit in CI), reported by /healthz.
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]
