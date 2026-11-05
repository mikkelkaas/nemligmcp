FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
LABEL org.opencontainers.image.source=https://github.com/mikkelkaas/nemligmcp
ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js"]
