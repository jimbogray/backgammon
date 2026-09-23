# Backgammon

Two-player online backgammon. Sign up (or continue with Google), challenge a friend by username or send them an invite link, and play in real time or one move at a time over days. Every game is saved on the server, so you can close the tab and pick up later from any device, and you can have as many games going at once as you like.

## Features

- **Accounts**: sign up with username, email and password, or one-click Google sign-in. The landing page is the sign-up / log-in screen until you're signed in.
- **Saved, resumable games**: the API stores each game's full position, dice, doubling cube and move history in Postgres.
- **Live or turn-by-turn**: when both players have the game open, moves appear instantly (Server-Sent Events). When they don't, the lobby shows which games are waiting on you.
- **Many games at once**: the lobby groups games into *Your turn*, *Waiting for opponent*, *Finished* and open invites.
- **Full rules**: bar entry, hitting, blocked points, must-use-both-dice and larger-die rules, bearing off, doubling cube (take / pass), gammons and backgammons, resignation. The server checks every move; the browser only shows moves the rules allow.
- **Invite links** for friends who don't have an account yet: they sign up from the link and land straight in the game.

## Stack

| Piece | Choice |
| --- | --- |
| Web app | React 19 + Vite, board drawn in SVG. A static site (Azure Static Web Apps in staging) |
| API | Node.js 20+, Express 5, TypeScript. A container (Azure Container Apps in staging) |
| Database | Postgres via `pg` (Azure Database for PostgreSQL in staging) |
| Real-time | Server-Sent Events; Postgres `LISTEN`/`NOTIFY` fans updates out across API replicas |
| Auth | bcrypt password hashes, random session tokens sent as `Authorization: Bearer`, Google OAuth 2.0 (no extra auth library) |
| Tests | Vitest + Supertest, against Postgres in-process via PGlite |

The web app and API are deployed separately and talk over HTTPS. The rules engine in `src/shared/engine.ts` is shared by the API (authoritative) and the browser (move highlighting).

## Running locally

You need Node 20+ and a Postgres. The easiest Postgres is Docker:

```bash
npm install
npm run db:up        # Postgres 17 on localhost:5432 (docker compose)
npm run dev          # API on :3000, web app on http://localhost:5173
npm test             # rules engine and API tests (no database needed)
npm run typecheck
```

The API creates the `backgammon` database and its tables on first start. To use another Postgres, set `DATABASE_URL` (see `.env.example`). In development the web app proxies `/api` to the API, so both run on one address.

### Using a Postgres you already run

If a Postgres is already listening on port 5432 (Homebrew, Postgres.app, another project's container), skip `npm run db:up`: its container needs the same port and won't start. The default `DATABASE_URL` signs in as `postgres` / `postgres`, a role that Homebrew and Postgres.app don't create. They make one named after your system user, with no password. Point the API at that role in `.env`:

```bash
cp .env.example .env
# then in .env:
DATABASE_URL=postgres://your-username@localhost:5432/backgammon
```

Your role needs permission to create databases (Homebrew's and Postgres.app's default role has it). Otherwise, create `backgammon` yourself with `createdb backgammon` first.

Open http://localhost:5173 in two different browsers (or one normal and one private window) to play yourself.

## Setting up Google sign-in

Google sign-in stays hidden until you add credentials:

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create a project (or pick one), then configure the **OAuth consent screen** (External, app name, your email; scopes `openid`, `email`, `profile`).
2. Create an **OAuth client ID** of type **Web application**.
3. Under **Authorized redirect URIs** add `API_URL/api/auth/google/callback` for each place the API runs, for example:
   - `http://localhost:5173/api/auth/google/callback` (local development, through the web app's proxy)
   - `https://api.your-domain.example/api/auth/google/callback` (production)
4. Copy `.env.example` to `.env` and fill in:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   APP_URL=http://localhost:5173
   ```
5. Restart the API. The log line says `Google sign-in: enabled` and the button appears.

If someone signs in with Google using the same verified email as an existing password account, the two are linked. Google users get a username from their name and can change it by clicking it in the header.

## Deploying

Merging to `main` deploys to the Azure **staging** environment through GitHub Actions: the web app to Azure Static Web Apps, the API to Azure Container Apps, and the database on Azure Database for PostgreSQL. One-time setup, costs and operating notes are in [`infra/README.md`](infra/README.md).

Elsewhere, the pieces are:

- **API:** `docker build -t backgammon-api .` (or `npm run build:api && npm start`). Set `APP_URL` (the web app's address, allowed by CORS), `API_URL` (its own public address, for Google sign-in), `DATABASE_URL`, and optionally the Google credentials.
- **Web app:** `VITE_API_URL=https://api.your-domain.example npm run build:web`, then serve `dist/client` from any static host. Unknown paths must fall back to `index.html`; `staticwebapp.config.json` does this on Azure.

Serve both over HTTPS in production.

## Project layout

```
src/shared/engine.ts   rules engine (moves, dice, cube, scoring)
src/shared/api.ts      JSON shapes shared by server and client
src/server/            Express API: auth, games, live events, Postgres
src/client/            React web app: sign-in, lobby, invite, game board
infra/                 Azure Bicep templates and setup notes
tests/                 engine and API tests
```
