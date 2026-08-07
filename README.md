# GoogleShift Backend - Production-Grade NestJS/Express Microservice

GoogleShift is an enterprise-grade, high-throughput Google Drive-to-Google Drive migration platform. This repository contains the production-optimized backend microservice built with Node.js, Express, TypeScript, Prisma ORM, PostgreSQL (Supabase), Redis, and Passport OAuth2.

---

## Technical Features

- **Port 3100 VPS Native Execution**: Built to operate on Port 3100 avoiding VPS host port collisions.
- **Multi-Stage Docker Containerization**: Minimal Node Alpine image footprint with non-root (`node`) execution and built-in container health checks.
- **Strict Environment Validation**: Startup config validation using `zod` preventing boot on missing or malformed environment variables.
- **Structured Production Logging**: Winston JSON logger with automatic secret redactor (`accessToken`, `refreshToken`, `passwordHash`, `SESSION_SECRET`) and request correlation tracing (`X-Request-Id`).
- **Comprehensive Health Probes**: `GET /health` diagnostic endpoint checking database connection pool latency, memory footprint, Node uptime, Redis status, and Google OAuth API reachability.
- **API Versioning**: Route structures accessible under `/api/v1/*` with backwards-compatible root endpoints.
- **Security Protections**: Rate limiting (`express-rate-limit`), Helmet security headers, Gzip compression, trust proxy configuration, and sanitized error responses.
- **Graceful Process Shutdown**: Traps `SIGTERM` and `SIGINT` to safely drain HTTP traffic, close Redis streams, and end database connection pools cleanly.

---

## Getting Started Locally

### Prerequisites

- Node.js >= 20.x
- npm >= 10.x
- PostgreSQL / Supabase Database
- Redis (Optional for caching)

### Installation

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### Configure Environment Variables

Edit `.env` and supply your database credentials and Google OAuth keys:

```env
NODE_ENV=development
PORT=3100
DATABASE_URL="postgresql://postgres:password@localhost:5432/googleshift"
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"
GOOGLE_LOGIN_REDIRECT_URI="http://localhost:3100/auth/google/callback"
GOOGLE_DRIVE_REDIRECT_URI="http://localhost:3100/auth/google/callback"
FRONTEND_URL="http://localhost:5173"
JWT_SECRET="development_jwt_secret"
SESSION_SECRET="development_session_secret"
```

### Running Development Server

```bash
# Start watch mode with tsx
npm run dev

# Run TypeScript type check
npm run typecheck

# Run unit tests
npm test
```

Swagger API Documentation is accessible at `http://localhost:3100/docs` in development mode.

---

## Running with Docker Compose

```bash
# Build and launch stack
docker compose up --build -d

# Check service logs
docker compose logs -f backend

# Verify health status
curl http://localhost:3100/health
```

---

## Deployment & CI/CD Pipeline

The backend is fully configured for automated GitHub Actions CI/CD deployment to a VPS at `/var/www/googleshift`.

For detailed step-by-step VPS configuration and secrets setup, refer to [DEPLOYMENT.md](file:///c:/Users/Admin/Desktop/GoogleShift/DEPLOYMENT.md).
