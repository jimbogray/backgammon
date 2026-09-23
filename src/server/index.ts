import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

// Load settings from a .env file when one exists (see .env.example).
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const config = loadConfig();
const db = openDatabase(config.databasePath, config.databaseJournalMode);
const app = createApp({ db, config, clientDir: path.resolve('dist', 'client') });

// Clear out expired login sessions now and once a day.
const purgeSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
purgeSessions();
setInterval(purgeSessions, 24 * 60 * 60 * 1000).unref();

app.listen(config.port, () => {
  console.log(`Backgammon server listening on http://localhost:${config.port}`);
  console.log(`Google sign-in: ${config.google ? 'enabled' : 'disabled (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)'}`);
});
