import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectPostgres, Database, ensureEntraRole, grantAppAccess, migrate } from './db.js';
import { EventHub } from './events.js';

// Load settings from a .env file when one exists (see .env.example).
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const EVENTS_CHANNEL = 'game_events';

const config = loadConfig();
const admin = await connectPostgres(config.databaseUrl, config.databaseAuth);
await migrate(admin);

let db: Database = admin;
const role = config.databaseAppRole;
if (role) {
  // Set up the limited role, then serve requests as it and let go of the admin connection.
  await ensureEntraRole(config.databaseUrl, role.user, role.objectId);
  await grantAppAccess(admin, role.user);
  db = await connectPostgres(config.databaseUrl, config.databaseAuth, { user: role.user, clientId: role.clientId });
  await admin.close();
}

// Live updates travel through Postgres so every API replica hears about every move.
const hub = new EventHub(async (message) => {
  await db.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, message]);
});
await db.listen(EVENTS_CHANNEL, { onMessage: hub.receive, onReconnect: hub.resync });

const app = createApp({ db, config, hub });

// Clear out expired login sessions now and once a day.
const purgeSessions = async () => {
  try {
    await db.query('DELETE FROM sessions WHERE expires_at <= now()');
    await db.query('DELETE FROM login_codes WHERE expires_at <= now()');
  } catch (err) {
    console.error('Purging expired sessions failed:', err);
  }
};
void purgeSessions();
setInterval(purgeSessions, 24 * 60 * 60 * 1000).unref();

const server = app.listen(config.port, () => {
  console.log(`Backgammon API listening on http://localhost:${config.port}`);
  console.log(`Web app: ${config.appUrl || '(APP_URL not set)'}; allowed origins: ${config.corsOrigins.join(', ') || 'none'}`);
  console.log(`Google sign-in: ${config.google ? 'enabled' : 'disabled (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)'}`);
});

// Container Apps sends SIGTERM before replacing a replica.
process.on('SIGTERM', () => {
  server.close();
  server.closeAllConnections();
  void db.close().finally(() => process.exit(0));
});
