FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:standalone

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data WEB_DIST=/app/public
COPY --from=build /app/artifacts/api-server/dist ./dist
COPY --from=build /app/artifacts/web/dist/public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
