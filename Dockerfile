FROM node:22-slim

WORKDIR /app

# Install FFmpeg (video frame extraction/probing) and CA certificates
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install production dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy application source, frontend assets, model weights, and seed data
COPY server.ts tsconfig.json ./
COPY src ./src
COPY public ./public
COPY models ./models
COPY data/seed_events.json ./data/seed_events.json

# Prepare writable runtime storage directory (SQLite DB + video uploads)
RUN mkdir -p /app/data/storage

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
