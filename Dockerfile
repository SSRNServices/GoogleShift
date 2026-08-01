# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app/backend

# Copy package files
COPY backend/package*.json ./

# Install dependencies WITHOUT lifecycle scripts
RUN npm ci --ignore-scripts

# Copy the ENTIRE backend
COPY backend .

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript
RUN npm run build


# Stage 2: Production Dependencies
FROM node:22-alpine AS deps

WORKDIR /app/backend

COPY backend/package*.json ./

# Install ONLY production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Copy Prisma schema and config
COPY backend/prisma ./prisma/
COPY backend/prisma.config.ts ./

# Generate Prisma Client for production
RUN npx prisma generate


# Stage 3: Runner
FROM node:22-alpine AS runner

WORKDIR /app/backend

# Set production environment
ENV NODE_ENV=production

# Run as non-root user (node user is built-in to node alpine images)
USER node

# Copy runtime dependencies
COPY --from=deps --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/backend/package.json ./
COPY --from=deps --chown=node:node /app/backend/prisma ./prisma
COPY --from=deps --chown=node:node /app/backend/prisma.config.ts ./prisma.config.ts

# Copy built files
COPY --from=builder --chown=node:node /app/backend/dist ./dist

EXPOSE ${PORT:-3000}

# Start application after running Prisma migrations
CMD ["npm", "run", "start:prod"]
