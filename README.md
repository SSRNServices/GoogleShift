# CloudShift

CloudShift is a local desktop/web migration utility designed to transfer data directly between two Google accounts without relying on an intermediate cloud backend, database, or persistent storage.

## Features
- **Direct Streaming**: Streams files directly from the source Google Drive to the destination Google Drive without saving files to local disk, minimizing memory usage.
- **Local Only**: No database, no Docker, no user accounts. Runs entirely on your local machine.
- **Account Support**: Connects multiple Google accounts using local OAuth flows.
- **Resilience**: Automatic retries with exponential backoff for network or API failures.
- **Folder Preservation**: Recursively maps and preserves the entire folder structure in the destination account.

## Tech Stack
- **Frontend**: React, Vite, TypeScript, TailwindCSS, shadcn/ui
- **Backend**: Node.js, Express, TypeScript, Google APIs

## Setup & Running

### Prerequisites
- Node.js (v18 or v22 LTS)
- Google Cloud Console project with Drive API enabled and OAuth credentials.

### Backend Setup
1. Navigate to the `backend/` directory.
2. Run `npm install`.
3. Create a `.env` file in the `backend/` directory and add your Google OAuth Client ID and Secret:
   ```env
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   ```
4. Start the backend: `npm run dev` (starts on port 3000)

### Frontend Setup
1. Navigate to the `frontend/` directory.
2. Run `npm install`.
3. Start the frontend: `npm run dev` (starts on Vite's default port, usually 5173).

## Architecture
The backend uses a Clean Architecture approach within an Express app, primarily relying on a `StorageProvider` interface that is implemented by `GoogleDriveProvider`. The frontend handles the configuration wizard and displays real-time streaming progress.
