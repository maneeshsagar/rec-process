# ─── Build Stage ─────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies for mediasoup (needs python3, make, g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first (better layer caching)
COPY package.json package-lock.json ./

# Install all dependencies (including dev for building client bundle)
RUN npm ci

# Copy source
COPY . .

# Build client bundle (minified for production)
RUN NODE_ENV=production npm run build

# ─── Production Stage ────────────────────────────────────────────────
FROM node:20-bookworm-slim

WORKDIR /app

# Install runtime dependencies for mediasoup native module
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built app from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/server ./server

# Don't run as root
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

# Expose ports
# HTTP/HTTPS
EXPOSE 3000
# mediasoup RTC (UDP + TCP range)
EXPOSE 40000-49999/udp
EXPOSE 40000-49999/tcp

ENV NODE_ENV=production

CMD ["node", "server/index.js"]
