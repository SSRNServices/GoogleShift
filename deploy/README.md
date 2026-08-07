# GoogleShift Backend Deployment Guide

This directory contains the production deployment configuration for the GoogleShift backend application on an Ubuntu VPS using Docker, Docker Compose, GitHub Container Registry (GHCR), and GitHub Actions.

---

## 🏗️ Architecture Overview

- **Repository**: `GoogleShift`
- **Deployment Target**: Ubuntu VPS (Ubuntu 22.04 / 24.04 LTS)
- **Deployment Directory**: `/var/www/googleshift`
- **Container Registry**: `ghcr.io/ssrnservices/googleshift-backend`
- **Container Name**: `googleshift-backend`
- **Production Port**: `3100`
- **Reverse Proxy**: Nginx (handling SSL termination via Let's Encrypt)
- **CI/CD Pipeline**: GitHub Actions (`.github/workflows/backend-deploy.yml`)

---

## 🛠️ Step 1: Initial VPS Setup

On your Ubuntu VPS, run the following steps once to prepare the environment:

### 1. Install Docker & Docker Compose
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx

# Install official Docker engine
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

### 2. Create Application Directory & Subdirectories
```bash
sudo mkdir -p /var/www/googleshift
sudo chown -R $USER:$USER /var/www/googleshift
cd /var/www/googleshift
mkdir -p logs uploads backups
```

### 3. Clone Repository
```bash
cd /var/www/googleshift
git clone https://github.com/ssrnservices/GoogleShift.git .
```

### 4. Create Production Environment File (`/var/www/googleshift/.env`)
Create `/var/www/googleshift/.env` with your production values:

```env
# Application Settings
NODE_ENV=production
PORT=3100
BACKEND_URL=https://api.googleshift.com
FRONTEND_URL=https://googleshift.com

# Security & Secrets
JWT_SECRET=your_strong_random_jwt_secret_64chars
SESSION_SECRET=your_strong_random_session_secret_64chars

# Database & Supabase Connections
DATABASE_URL=postgresql://postgres:password@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres:password@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres

# Google OAuth Credentials
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-google-client-secret
GOOGLE_LOGIN_REDIRECT_URI=https://api.googleshift.com/auth/google/callback
GOOGLE_DRIVE_REDIRECT_URI=https://api.googleshift.com/auth/google/callback

# CORS Configuration
CORS_ORIGIN=https://googleshift.com,https://www.googleshift.com,https://app.googleshift.com,https://migration.ssrnservices.in
```

---

## 🔑 Step 2: Configure GitHub Repository Secrets

Under your repository **Settings -> Secrets and variables -> Actions**, configure the following:

| Secret Name | Description | Example |
|---|---|---|
| `VPS_HOST` | VPS IP address or domain | `192.0.2.1` |
| `VPS_USER` | SSH user | `ubuntu` or `root` |
| `VPS_SSH_KEY` | Private SSH key (PEM format) | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `VPS_PORT` | SSH port (optional, defaults to 22) | `22` |

*Note: The built-in `${{ secrets.GITHUB_TOKEN }}` is automatically used for GHCR authentication.*

---

## 🔄 Step 3: CI/CD Deployment Workflow

Every push to `main` modifying files in `backend/**`, `deploy/**`, or `.github/workflows/backend-deploy.yml` triggers the automated pipeline:

1. **Build**: Builds multi-stage Docker image from `backend/Dockerfile` with build context `backend`.
2. **Push**: Pushes tagged images (`latest` and `${{ github.sha }}`) to GHCR.
3. **Deploy**: SSHs into VPS `/var/www/googleshift`, syncs `deploy/docker-compose.yml`, pulls latest image from GHCR, and starts containers with `docker compose up -d`.
4. **Health Check**: Polls `http://127.0.0.1:3100/health` up to 60 seconds to verify HTTP 200 `status: "ok"`.

---

## ⚡ Manual Deployment & Operations

### Manually Trigger Deployment via GitHub Actions
Go to the **Actions** tab in GitHub -> Select **Backend CI/CD Pipeline - GHCR to VPS** -> Click **Run workflow**.

### Manually Pull and Deploy on VPS
```bash
cd /var/www/googleshift
docker compose pull
docker compose up -d
```

### Restart Backend Container
```bash
cd /var/www/googleshift
docker compose restart backend
```

---

## ⏪ Rollback Strategy

If a deployment introduces issues, you can instantly roll back to any previous commit SHA image tag without rebuilding:

```bash
cd /var/www/googleshift

# Pull and run specific commit SHA image
docker pull ghcr.io/ssrnservices/googleshift-backend:<COMMIT_SHA>
docker tag ghcr.io/ssrnservices/googleshift-backend:<COMMIT_SHA> ghcr.io/ssrnservices/googleshift-backend:latest
docker compose up -d
```

---

## 🩺 Diagnostic & Useful Commands

```bash
# Check container status & health status
docker ps

# Stream live container logs
docker logs -f googleshift-backend

# Test health check response directly
curl -s http://127.0.0.1:3100/health

# Execute interactive shell inside running container
docker exec -it googleshift-backend sh

# Inspect container health history
docker inspect --format='{{json .State.Health}}' googleshift-backend

# Clean unused Docker images
docker image prune -f
```
