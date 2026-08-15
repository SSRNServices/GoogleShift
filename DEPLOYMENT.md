# GoogleShift Backend Deployment Guide (Port 3100 VPS Setup)

This guide provides instructions for deploying the GoogleShift backend to a VPS using Docker, Docker Compose, Nginx, and GitHub Actions CI/CD.

---

## Architecture Overview

- **Host Path on VPS**: `/var/www/googleshift`
- **Exposed Host Port**: `3100` (Avoids collisions with 3000, 3001, 5432, 5433, 5678, 6379, 8000, 9000, 9001)
- **Container Registry**: GitHub Container Registry (`ghcr.io/ssrnservices/googleshift-backend`)
- **Container Name**: `googleshift-backend`
- **Orchestration**: Docker Compose
- **Reverse Proxy**: Nginx with Let's Encrypt SSL
- **CI/CD Pipeline**: GitHub Actions (`.github/workflows/deploy.yml`)

---

## Step 1: Initial VPS Setup

### 1. Update Server & Install Dependencies

On your VPS (Ubuntu 22.04 / 24.04 LTS):

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx

# Install Docker & Docker Compose Plugin
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

### 2. Create Application Directory Structure

```bash
sudo mkdir -p /var/www/googleshift
sudo chown -R $USER:$USER /var/www/googleshift
cd /var/www/googleshift
```

### 3. Clone Repository & Setup Environment

```bash
git clone https://github.com/ssrnservices/GoogleShift.git .
cp backend/.env.example backend/.env
nano backend/.env
```

Populate `backend/.env` with your production keys:
- Set `NODE_ENV=production`
- Set `PORT=3100`
- Set strong random values for `JWT_SECRET` and `SESSION_SECRET`
- Supply `DATABASE_URL` (Self-hosted PostgreSQL 18.4 connection string: `postgresql://googleshift:password@googleshift-db:5432/googleshift`)
- Supply `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

---

## Step 2: Nginx Reverse Proxy & SSL Setup

Create Nginx server block configuration `/etc/nginx/sites-available/api.googleshift.com`:

```nginx
server {
    server_name api.googleshift.com api.migration.ssrnservices.in;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Disable SSE buffering
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
}
```

Enable site & obtain SSL certificate:

```bash
sudo ln -s /etc/nginx/sites-available/api.googleshift.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d api.googleshift.com -d api.migration.ssrnservices.in
```

---

## Step 3: Configure GitHub Repository Secrets

In your GitHub repository under **Settings -> Secrets and variables -> Actions**, add:

| Secret Name | Description | Example |
|---|---|---|
| `VPS_HOST` | Server IP address or domain | `192.0.2.1` or `api.googleshift.com` |
| `VPS_USERNAME` | SSH user | `root` or `deploy` |
| `VPS_SSH_KEY` | Private SSH Key for authentication | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `VPS_PORT` | SSH Port (optional, defaults to 22) | `22` |

---

## Step 4: First Deployment

Trigger deployment manually via GitHub Actions tab, or execute Docker Compose manually on your VPS:

```bash
cd /var/www/googleshift
docker compose up -d --build
docker exec googleshift-backend npx prisma migrate deploy
```

Verify status:

```bash
curl http://localhost:3100/health
# or
curl https://api.googleshift.com/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2026-08-07T12:00:00.000Z",
  "uptime": 120,
  "version": "1.0.0",
  "environment": "production",
  "database": {
    "connected": true,
    "latencyMs": 15
  }
}
```
