FROM node:24-alpine AS build
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY .yarn ./.yarn
COPY packages/agent-runtime ./packages/agent-runtime
RUN corepack enable && yarn workspaces focus agent-runtime && yarn workspace agent-runtime build

FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY .yarn ./.yarn
COPY packages/agent-runtime/package.json ./packages/agent-runtime/package.json
RUN corepack enable && yarn workspaces focus agent-runtime --production

FROM node:24-alpine AS runtime
WORKDIR /app/packages/agent-runtime
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/packages/agent-runtime/dist ./dist
COPY --from=build /app/packages/agent-runtime/package.json ./package.json
EXPOSE 3100
CMD ["node", "dist/main"]
