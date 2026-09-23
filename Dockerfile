# Local production image. Provider credentials are removed by the runtime
# entrypoint so this image cannot call the configured external APIs.
ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=10.28.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    RAYON_NUM_THREADS=1 \
    NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=4"
WORKDIR /app
RUN corepack enable pnpm && corepack install --global pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run check && pnpm run build
RUN pnpm prune --prod

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_NAME="Voice Router"
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends -y ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/data ./data
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/env", "-u", "OPENAI_API_KEY", "-u", "YANDEX_SERVICE_ACCOUNT_ID", "-u", "YANDEX_SERVICE_ACCOUNT_KEY_ID", "-u", "YANDEX_SERVICE_ACCOUNT_PRIVATE_KEY", "-u", "YANDEX_FOLDER_ID", "-u", "ELEVENLABS_API_KEY", "-u", "ELEVENLABS_VOICE_ID"]
CMD ["node", "dist/server/index.js"]
