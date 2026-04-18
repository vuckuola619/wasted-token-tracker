# ────────────────────────────────────────────────────────
# AG-Code Token — Docker Image
# Multi-stage build for minimal attack surface.
#
# Build:  docker build -t ag-code-token .
# Run:    docker run -p 3777:3777 -v ~/.ag-code-token:/home/agtoken/.ag-code-token ag-code-token
# ────────────────────────────────────────────────────────

# Stage 1: Build context (copy + validate)
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
# No npm install needed — zero dependencies!
COPY . .
# Validate syntax of all JS files
RUN node --check server.js \
    && node --check models.js \
    && node --check parser.js \
    && node --check security.js \
    && node --check budget.js \
    && node --check webhooks.js \
    && node --check currency.js \
    && node --check watcher.js \
    && node --check cli.js \
    && node --check index.js

# Stage 2: Production image
FROM node:22-alpine AS runtime

# Security: Labels
LABEL maintainer="vuckuola619"
LABEL org.opencontainers.image.title="AG-Code Token"
LABEL org.opencontainers.image.description="Universal AI coding token usage monitor"
LABEL org.opencontainers.image.version="1.3.0"
LABEL org.opencontainers.image.source="https://github.com/vuckuola619/wasted-token-tracker"

# Security: Non-root user
RUN addgroup -g 1001 agtoken && \
    adduser -u 1001 -G agtoken -s /bin/sh -D agtoken

WORKDIR /app

# Copy application files
COPY --from=builder --chown=agtoken:agtoken /app/ ./

# Create config directory
RUN mkdir -p /home/agtoken/.ag-code-token && \
    chown -R agtoken:agtoken /home/agtoken

# Switch to non-root user
USER agtoken

# Environment defaults
ENV PORT=3777
ENV AG_TOKEN_HOST=0.0.0.0
ENV AG_TOKEN_AUTH=required
ENV HOME=/home/agtoken
ENV NODE_ENV=production

# Expose port
EXPOSE 3777

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3777/api/health || exit 1

# Volumes for persistent data
VOLUME ["/home/agtoken/.ag-code-token"]
# Mount session directories from host:
# -v ~/.gemini:/home/agtoken/.gemini:ro
# -v ~/.claude:/home/agtoken/.claude:ro
# -v ~/.cursor:/home/agtoken/.cursor:ro

# Start
CMD ["node", "server.js"]
