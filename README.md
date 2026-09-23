# Backgammon

Two-player online backgammon. Sign up (or continue with Google), challenge a friend by username or send them an invite link, and play in real time or one move at a time over days. Every game is saved on the server, so you can close the tab and pick up later from any device, and you can have as many games going at once as you like.

## Features

- **Accounts**: sign up with username, email and password, or one-click Google sign-in. The landing page is the sign-up / log-in screen until you're signed in.
- **Saved, resumable games**: the server stores each game's full position, dice, doubling cube and move history in SQLite.
- **Live or turn-by-turn**: when both players have the game open, moves appear instantly (Server-Sent Events). When they don't, the lobby shows which games are waiting on you.
- **Many games at once**: the lobby groups games into *Your turn*, *Waiting for opponent*, *Finished* and open invites.
- **Full rules**: bar entry, hitting, blocked points, must-use-both-dice and larger-die rules, bearing off, doubling cube (take / pass), gammons and backgammons, resignation. The server checks every move; the browser only shows moves the rules allow.
- **Invite links** for friends who don't have an account yet: they sign up from the link and land straight in the game.

## Stack

| Piece | Choice |
| --- | --- |
| Server | Node.js 20+, Express 5, TypeScript |
| Database | SQLite via `better-sqlite3` (a single file, no separate database server) |
| Client | React 19 + Vite, board drawn in SVG |
| Real-time | Server-Sent Events |
| Auth | bcrypt password hashes, random session tokens in an HTTP-only cookie, Google OAuth 2.0 (no extra auth library) |
| Tests | Vitest + Supertest |

The rules engine in `src/shared/engine.ts` is shared by the server (authoritative) and the browser (move highlighting).

## Running locally

```bash
npm install
npm run dev          # server on :3000, app on http://localhost:5173
npm test             # rules engine and API tests
npm run typecheck
```

Open http://localhost:5173 in two different browsers (or one normal and one private window) to play yourself.

## Setting up Google sign-in

Google sign-in stays hidden until you add credentials:

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create a project (or pick one), then configure the **OAuth consent screen** (External, app name, your email; scopes `openid`, `email`, `profile`).
2. Create an **OAuth client ID** of type **Web application**.
3. Under **Authorized redirect URIs** add `APP_URL/auth/google/callback` for each place the app runs, for example:
   - `http://localhost:5173/auth/google/callback` (local development)
   - `https://your-domain.example/auth/google/callback` (production)
4. Copy `.env.example` to `.env` and fill in:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   APP_URL=http://localhost:5173
   ```
5. Restart the server. The log line says `Google sign-in: enabled` and the button appears.

If someone signs in with Google using the same verified email as an existing password account, the two are linked. Google users get a username from their name and can change it by clicking it in the header.

## Deploying

The app is a single Node process plus one SQLite file, so any host that gives you a persistent disk works (Fly.io, Railway, Render with a disk, a small VPS).

```bash
npm ci
npm run build
NODE_ENV=production APP_URL=https://your-domain.example DATABASE_PATH=/data/backgammon.db npm start
```

Or with Docker:

```bash
docker build -t backgammon .
docker run -p 3000:3000 -v backgammon-data:/data \
  -e APP_URL=https://your-domain.example \
  -e GOOGLE_CLIENT_ID=... -e GOOGLE_CLIENT_SECRET=... \
  backgammon
```

Serve it over HTTPS in production: session cookies are marked `Secure` when `NODE_ENV=production`. Live updates are held in memory, so run a single instance (moving to Postgres plus a shared pub/sub would be the step for scaling out).

## Project layout

```
src/shared/engine.ts   rules engine (moves, dice, cube, scoring)
src/shared/api.ts      JSON shapes shared by server and client
src/server/            Express app: auth, games API, live events, SQLite
src/client/            React app: sign-in, lobby, invite, game board
tests/                 engine and API tests
```
