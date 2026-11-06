# Node 26 images no longer ship corepack, so fetch the pinned pnpm release binary directly.
FROM node:26-slim AS base
ARG PNPM_VERSION=12.17.0
ARG TARGETARCH
RUN arch="$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64)" \
 && node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('/tmp/pnpm.tgz',Buffer.from(b)))" \
      "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${arch}.tar.gz" \
 && mkdir -p /opt/pnpm && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm && rm /tmp/pnpm.tgz
ENV PATH=/opt/pnpm:$PATH PNPM_HOME=/pnpm
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
RUN pnpm build

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:26-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/node/server/main.js"]
