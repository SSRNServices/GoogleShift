FROM node:22-alpine

WORKDIR /app

# Copy the backend package files to leverage Docker caching
COPY backend/package*.json ./backend/

# Move into backend to run install
WORKDIR /app/backend

# Copy Prisma schema and config required by postinstall hook
COPY backend/prisma ./prisma/
COPY backend/prisma.config.ts ./

RUN npm ci

# Copy the rest of the backend source
COPY backend /app/backend

# Generate prisma client and build
RUN npx prisma generate
RUN npm run build

# Expose port (default to 3000 if not set)
EXPOSE ${PORT:-3000}

# Start the application
CMD ["npm", "run", "start:prod"]
