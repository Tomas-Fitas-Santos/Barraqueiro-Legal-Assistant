# Lean standalone Next.js image for the Barraqueiro Legal Assistant.
# node:sqlite ships with Node 22, so there is NO Python / native build step.

# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- build ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 300 MB of the onnxruntime package is CUDA and TensorRT providers for GPUs this container
# will never have. Removed before tracing so they cannot reach the runner layer.
RUN rm -f node_modules/onnxruntime-node/bin/napi-v6/*/*/libonnxruntime_providers_cuda.so \
          node_modules/onnxruntime-node/bin/napi-v6/*/*/libonnxruntime_providers_tensorrt.so
RUN npm run build
RUN LEGAL_MODELS_DIR=/app/models node scripts/fetch-encoder.mjs

# ---- runner ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV LEGAL_DATA_DIR=/data-home
# poppler-utils: pdftoppm rasterizes scanned pages for the OCR vision stage (phase 2).
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /data-home && chown nextjs:nodejs /data-home
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# The encoder's weights, baked in. Downloading them at first boot would make a fresh
# container's first ingest hang on a 120 MB fetch, and an air-gapped deploy never work.
COPY --from=builder --chown=nextjs:nodejs /app/models /app/models
ENV LEGAL_MODELS_DIR=/app/models
ENV LEGAL_EMBED_OFFLINE=1
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
