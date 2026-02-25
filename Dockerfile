# ── Multi-stage Docker Build ─────────────────────────────────────────────────
# Stage 1: Install production dependencies only
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: Production image
FROM node:24-alpine AS runtime
WORKDIR /app

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy only production deps + source
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY index.js ./
COPY bond-directory/ ./bond-directory/

# Do NOT copy .env into the image — inject secrets at runtime via env vars
# Do NOT copy frontend_bonds_export.json — provide via BOND_MONGO_URI instead

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 5050

# Health check — waits 10s for startup, checks every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5050/api/health || exit 1

# Start the application
CMD ["node", "index.js"]
