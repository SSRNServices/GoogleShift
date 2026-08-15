# Multi-stage production Dockerfile for GoogleShift Backend

# Stage 1: Builder
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

COPY . .
RUN npm run build

# Stage 2: Runner
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3100
ENV MANIFEST_STORAGE_PATH=/app/data/manifests

RUN mkdir -p /app/data/manifests && chown -R node:node /app/data

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3100/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/index.js"]
