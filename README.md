<div align="center">
  <br />
  <img src="https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/cloud-lightning.svg" width="80" height="80" alt="CloudShift Logo" />
  <h1>CloudShift</h1>
  <p><strong>The Ultimate Desktop & Web Migration Utility for Google Drive</strong></p>
  <p>
    Seamlessly transfer files, folders, and entire storage infrastructures directly between Google accounts without downloading them to your local disk.
  </p>
  <br />
</div>

## 🚀 Overview

CloudShift is a state-of-the-art data migration utility designed for privacy, speed, and reliability. By utilizing direct cloud-to-cloud passthrough streams, CloudShift bypasses the need for local storage, intermediate databases, or third-party servers. Your data flows securely from the source Google account to the destination.

### 🌟 Key Features

- **Direct Cloud Streaming:** Pipes data directly via Node.js PassThrough streams. No large temp files. Flat memory footprint.
- **Zero Configuration Architecture:** No Docker, no Redis, no PostgreSQL. Pure Node.js and React.
- **Visual Drive Explorer:** Built-in, high-performance virtualized file browser to select specific payloads.
- **Advanced Transfer Engine:** Complete control over conflict strategies, checksum verification, and folder structure preservation.
- **Resilient Connectivity:** Exponential backoff and auto-retry for transient DNS drops, API timeouts, and network interruptions.

## 🛠️ Technology Stack

Designed with modern engineering practices, CloudShift delivers a premium SaaS-like experience on a local stack.

| Category | Technology |
| :--- | :--- |
| **Frontend** | React 18, Vite, TypeScript, TailwindCSS, `lucide-react`, `@tanstack/react-query`, `@tanstack/react-virtual` |
| **Backend** | Node.js, Express, TypeScript, `googleapis` |
| **Auth** | Secure Local OAuth2.0 Flows |

## ⚙️ Getting Started

### 1. Prerequisites
- **Node.js** (v18 or v22 LTS)
- A **Google Cloud Console** project with the **Google Drive API** enabled.
- OAuth 2.0 Client IDs configured for `http://localhost:3000`.

### 2. Backend Setup
```bash
cd backend
npm install
```

Create a `.env` file in the `backend/` directory:
```env
GOOGLE_CLIENT_ID=your_oauth_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_oauth_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
FRONTEND_URL=http://localhost:5173
```

Start the API server:
```bash
npm run dev
```

### 3. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

The stunning UI will be available at `http://localhost:5173`.

## 🧠 Architecture Highlights

CloudShift strictly adheres to a **Clean Architecture** model:
- **Stateless Backend:** Authentication states and tokens are persisted securely in local temporary JSON files (`tokens/`), keeping the server stateless.
- **Modular Frontend:** The UI is completely isolated, utilizing Shared TypeScript models (`src/types/`) ensuring robust end-to-end type safety.
- **Transfer Engine (Phase 3):** Dynamically scales concurrent upload streams based on active network throughput and API quota limits.

## 🔒 Privacy & Security

CloudShift runs **locally on your machine**. 
- No telemetry.
- No remote databases.
- No third-party API gateways.

Your Google OAuth tokens never leave your local environment.

---
<div align="center">
  <sub>Built with modern tools for modern workflows.</sub>
</div>
