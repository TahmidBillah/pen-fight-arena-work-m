# Pen Fight Arena — Firebase & Vercel Online Multiplayer Setup Guide

This document covers the setup, security rules, and deployment configuration for the **Turn-Based Online 1v1** multiplayer system backed by **Firebase Authentication**, **Firebase Realtime Database**, and **Vercel Serverless Functions**.

---

## 1. Architecture Summary

- **Frontend (`src/`)**: React 19 + TypeScript + Three.js + Rapier3D client. Only uses public `VITE_FIREBASE_*` web configuration (never contains private Admin SDK keys).
- **Authentication (`src/online/firebaseClient.ts`)**: Firebase Authentication with Google Sign-In (`GoogleAuthProvider` with `prompt: 'select_account'`, `signInWithPopup`, persistent browser session, automatic profile creation on first login).
- **Serverless Backend (`api/*.ts` & `server/online/`)**:
  - **Vercel**: Each endpoint in `/api/**/*.ts` compiles to an isolated Node.js serverless function configured in `vercel.json` (`maxDuration: 15`, `memory: 1024`).
  - **Local Dev**: `server.ts` runs Express on port `3000`, serving all `/api/*` routes alongside Vite middleware (`npm run dev`).
  - **Token Verification**: Server endpoints verify Firebase ID tokens from `Authorization: Bearer <idToken>` using `firebase-admin/auth`.
- **Authoritative Physics (`src/shared/AuthoritativePhysics.ts`)**: Runs Rapier3D WASM deterministically on the server in canonical horizontal coordinates (`TABLE_HALF_W = 9.75`, `TABLE_HALF_D = 6.25`) so desktop and mobile players compete fairly. Clients replay the verified 30 Hz keyframes and collision events.
- **Database (`database.rules.json`)**: Firebase Realtime Database storing `/users/{uid}`, `/rooms/{roomCode}`, `/matchHistory/{uid}/{matchId}`, `/playerStats/{uid}`, and server-only indexes (`/nicknames`, `/rateLimits`, `/matchIndex`). Clients can read rooms they belong to and update only their own `/rooms/{roomCode}/players/{uid}/connection` presence status; all scores, turns, match states, and outcomes are committed server-side via atomic Admin SDK RTDB transactions.
- **Realtime Sync (`src/online/useOnlineRoom.ts`)**: Subscribes directly to `/rooms/{roomCode}` with Firebase RTDB `onValue` and tracks live presence via `.info/connected` + `onDisconnect`.

---

## 2. Firebase Console Setup

1. Open [Firebase Console](https://console.firebase.google.com/) and create or select a Firebase project.
2. **Register Web App**:
   - Click **Project Overview → Add App → Web (`</>`)**.
   - Copy the SDK config fields into your `VITE_FIREBASE_*` environment variables.
3. **Enable Google Authentication**:
   - Go to **Build → Authentication → Get Started**.
   - Under **Sign-in method**, enable **Google**, set a support email, and Save.
   - Go to **Authentication → Settings → Authorized domains** and add:
     - `localhost` (already enabled by default)
     - Your AI Studio Development App hostname (`ais-dev-...run.app`)
     - Your AI Studio Shared App hostname (`ais-pre-...run.app`)
     - Your production Vercel domain (`your-app.vercel.app`)
4. **Enable Firebase Realtime Database**:
   - Go to **Build → Realtime Database → Create Database**.
   - Copy the database URL (`https://<project-id>-default-rtdb.firebaseio.com` or regional URL) into `VITE_FIREBASE_DATABASE_URL` and `FIREBASE_DATABASE_URL`.
   - Open the **Rules** tab and publish the exact rules from `/database.rules.json` (or deploy via `firebase deploy --only database`).
5. **Generate Firebase Admin Service Account Key (Server Only)**:
   - Go to **Project Settings → Service accounts → Firebase Admin SDK**.
   - Click **Generate new private key** and download the JSON file.
   - Extract `project_id`, `client_email`, and `private_key` for `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`.
   - Keep `FIREBASE_PRIVATE_KEY` strictly on the server (Vercel Environment Variables / local `.env`) — never expose it in `VITE_*` variables.

---

## 3. Environment Variables

Copy `.env.example` to `.env` for local development, and configure the same keys in **Vercel → Project Settings → Environment Variables**:

| Variable | Exposure | Description |
| --- | --- | --- |
| `VITE_FIREBASE_API_KEY` | Client | Firebase Web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Client | Firebase Auth domain (`<project>.firebaseapp.com`) |
| `VITE_FIREBASE_DATABASE_URL` | Client | Firebase Realtime Database URL |
| `VITE_FIREBASE_PROJECT_ID` | Client | Firebase Project ID |
| `VITE_FIREBASE_STORAGE_BUCKET` | Client | Firebase Storage bucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Client | Firebase Messaging Sender ID |
| `VITE_FIREBASE_APP_ID` | Client | Firebase Web App ID |
| `FIREBASE_PROJECT_ID` | **Server Only** | Service Account `project_id` |
| `FIREBASE_CLIENT_EMAIL` | **Server Only** | Service Account `client_email` |
| `FIREBASE_PRIVATE_KEY` | **Server Only** | Service Account `private_key` (with `\n` newlines) |
| `FIREBASE_DATABASE_URL` | **Server Only** | Firebase Realtime Database URL |
| `APP_URL` | Server / Docs | Canonical origin URL of your deployment |

---

## 4. Database Schema (`/database.rules.json`)

- `/users/{uid}` — User identity & career record (`uid`, `displayName`, `email`, `photoURL`, `nickname`, `createdAt`, `totalMatches`, `wins`, `losses`, `draws`).
- `/playerStats/{uid}` — Verified match & shot counters (`totalMatches`, `wins`, `losses`, `draws`, `totalShots`, `totalKnockouts`).
- `/matchHistory/{uid}/{matchId}` — Per-user completed match log (`opponentUid`, `opponentNickname`, `outcome`, `resultType`, `turnsPlayed`, `shotsCount`, `playedAt`).
- `/rooms/{roomCode}` — Active private 1v1 room (`hostUid`, `status`, `createdAt`, `maxPlayers`, `currentTurnUid`, `currentTurnNumber`, `gameSettings`, `players/{uid}`, `gameState`, `lastShot`).

---

## 5. Server API Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/health` | `GET` | Reports server & Firebase Admin configuration readiness |
| `/api/profile/me` | `GET`, `PATCH` | Auto-provisions / fetches `/users/{uid}` + history; updates unique nickname |
| `/api/rooms/create` | `POST` | Creates a 6-character private room (`WAITING`) and assigns Slot 1 (Blue Host) |
| `/api/rooms/join` | `POST` | Atomically joins a `WAITING` room as Slot 2 (Red Guest) via RTDB transaction |
| `/api/rooms/detail` | `GET` | Fetches room snapshot for members (supports refresh recovery) |
| `/api/rooms/ready` | `POST` | Updates pen loadout, ready status, and host arena/timer rules |
| `/api/rooms/leave` | `POST` | Leaves/cancels waiting room or cleanly forfeits an active match |
| `/api/matches/start` | `POST` | Host starts match atomically once both players are Ready |
| `/api/matches/submit-shot` | `POST` | Verifies active turn, runs server Rapier3D physics, commits turn atomically |
| `/api/matches/state` | `GET`, `POST` | Fetches authoritative match snapshot for participants |
| `/api/matches/finish` | `POST` | Adjudicates turn timeout skips or match forfeits atomically and saves stats/history |

---

## 6. Local Development & Vercel Deployment

### Local Development
```bash
npm install
npm run dev
```
Runs `tsx server.ts` on `http://localhost:3000` with Express serving `/api/*` and Vite serving the React app.

### Build & Deploy to Vercel
```bash
npm run lint
npm run build
```
Push to GitHub and import into Vercel (`vercel.json` configures static `dist/` output and `api/**/*.ts` Node serverless functions with `1024MB` memory and `15s` timeout for server-side Rapier3D physics).
