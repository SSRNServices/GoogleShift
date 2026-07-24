FROM node:22-alpine

WORKDIR /app/backend

#
# Copy package files first
#
COPY backend/package*.json ./

#
# Install dependencies WITHOUT lifecycle scripts
#
RUN npm ci --ignore-scripts

#
# Copy the ENTIRE backend
#
COPY backend .

#
# Verify files exist
#
RUN ls -R
RUN ls prisma
RUN test -f prisma/schema.prisma

#
# Docker debugging
#
RUN pwd
RUN ls
RUN ls prisma
RUN cat prisma/schema.prisma

#
# Generate Prisma Client
#
RUN npx prisma generate

#
# Build Typescript
#
RUN npm run build

EXPOSE 3000

CMD ["npm","run","start:prod"]
