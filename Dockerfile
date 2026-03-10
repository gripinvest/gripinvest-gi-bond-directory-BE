# ── Multi-stage Docker Build ─────────────────────────────────────────────────
# Stage 1: Install production dependencies only
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: Production image
FROM node:22-alpine AS runtime
WORKDIR /app

# Copy only production deps + source
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY index.js ./
COPY bond-directory/ ./bond-directory/

# Do NOT copy .env into the image — inject secrets at runtime via env vars
# Do NOT copy frontend_bonds_export.json — provide via BOND_MONGO_URI instead

# Expose port
EXPOSE 5050

# Start the application
CMD ["node", "index.js"]
