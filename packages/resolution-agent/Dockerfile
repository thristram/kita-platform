FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/resolution-agent/package.json packages/resolution-agent/package.json
RUN npm ci
COPY packages/contracts packages/contracts
COPY packages/resolution-agent packages/resolution-agent
RUN npm run build --workspace @kita/contracts && npm run build --workspace @kita/resolution-agent
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/resolution-agent/package.json ./packages/resolution-agent/package.json
COPY --from=build /app/packages/resolution-agent/dist ./packages/resolution-agent/dist
USER node
CMD ["node", "packages/resolution-agent/dist/cli.js", "worker"]
