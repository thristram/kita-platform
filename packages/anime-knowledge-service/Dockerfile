FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/anime-knowledge-service/package.json packages/anime-knowledge-service/package.json
RUN npm ci
COPY packages/contracts packages/contracts
COPY packages/anime-knowledge-service packages/anime-knowledge-service
RUN npm run build --workspace @kita/contracts && npm run build --workspace @kita/anime-knowledge-service
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/anime-knowledge-service/package.json ./packages/anime-knowledge-service/package.json
COPY --from=build /app/packages/anime-knowledge-service/dist ./packages/anime-knowledge-service/dist
USER node
CMD ["node", "packages/anime-knowledge-service/dist/cli.js", "serve"]
