# syntax=docker/dockerfile:1

ARG NODE_VERSION=24-bookworm-slim
ARG DOCKER_CLI_VERSION=29.6.1
ARG DOCKER_CLI_SHA256_AMD64=b0df4a43a98d7ecb708acbdb5a34a3416e13b6e39bcbbdf296f51f0f3442b29f
ARG DOCKER_CLI_SHA256_ARM64=917a4bb83565bcacb38c430f08daae8b59db3256331ac23f22394f0542509881

FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app

COPY tsconfig.json ./
COPY agent ./agent
COPY config ./config

ARG HOOTLINE_MODEL_PROVIDER=anthropic
ARG HOOTLINE_MODEL=claude-sonnet-4-6
ARG HOOTLINE_MODEL_BASE_URL=
ARG HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS=
ARG HOOTLINE_MODEL_PROVIDER_NAME=

# Eve compiles the selected model into the output. These placeholder
# credentials satisfy build-time provider validation without baking secrets.
RUN HOOTLINE_MODEL_PROVIDER="${HOOTLINE_MODEL_PROVIDER}" \
    HOOTLINE_MODEL="${HOOTLINE_MODEL}" \
    HOOTLINE_MODEL_BASE_URL="${HOOTLINE_MODEL_BASE_URL}" \
    HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS="${HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS}" \
    HOOTLINE_MODEL_PROVIDER_NAME="${HOOTLINE_MODEL_PROVIDER_NAME}" \
    ANTHROPIC_API_KEY=build-time-placeholder \
    OPENAI_API_KEY=build-time-placeholder \
    AI_GATEWAY_API_KEY=build-time-placeholder \
    npm run build

FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ARG DOCKER_CLI_VERSION
ARG DOCKER_CLI_SHA256_AMD64
ARG DOCKER_CLI_SHA256_ARM64
ARG TARGETARCH

LABEL org.opencontainers.image.source="https://github.com/openhoo/hootline" \
      org.opencontainers.image.description="Eve agent that repairs failing GitHub Actions and GitLab CI pipelines" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOOTLINE_STATE_PATH=/data/hootline-state.json \
    HOOTLINE_LOG_LEVEL=info \
    EVE_LOG_LEVEL=info \
    NODE_PATH=/app/node_modules

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
  && case "${TARGETARCH:-amd64}" in \
      amd64) docker_arch="x86_64"; docker_sha256="${DOCKER_CLI_SHA256_AMD64}" ;; \
      arm64) docker_arch="aarch64"; docker_sha256="${DOCKER_CLI_SHA256_ARM64}" ;; \
      *) echo "Unsupported Docker CLI architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && test -n "${docker_sha256}" \
  && curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
  && echo "${docker_sha256}  /tmp/docker.tgz" | sha256sum -c - \
  && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
  && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /tmp/docker /tmp/docker.tgz \
  && mkdir -p /app /data \
  && chown -R node:node /app /data

COPY --chown=node:node --from=build /app/.output ./.output
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/eve/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
