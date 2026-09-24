import { DefaultAzureCredential } from '@azure/identity';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface ListenHandlers {
  onMessage: (payload: string) => void;
  /** Called after the listening connection drops and comes back; messages may have been missed. */
  onReconnect?: () => void;
}

export interface Database extends Queryable {
  /** Runs `fn` in a transaction, committing if it resolves and rolling back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Receives every NOTIFY on `channel`, from this server or any other connected to the database. */
  listen(channel: string, handlers: ListenHandlers): Promise<void>;
  close(): Promise<void>;
}

export type DatabaseAuth = 'password' | 'entra';

// Postgres returns BIGINT and NUMERIC as strings; the app only uses them for counts.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

const ENTRA_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

/** Connect as someone other than the connection string's user: another managed identity. */
export interface ConnectAs {
  user: string;
  /** Client ID of the managed identity whose token signs `user` in. */
  clientId: string;
}

function poolConfig(url: string, auth: DatabaseAuth, as?: ConnectAs): pg.PoolConfig {
  const parsed = parseConnectionString(url);
  const config: pg.PoolConfig = {
    host: parsed.host ?? undefined,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.database ?? undefined,
    user: as?.user ?? parsed.user,
    password: parsed.password || undefined,
    ssl: parsed.ssl as pg.PoolConfig['ssl'],
    max: 10,
  };
  if (auth === 'entra') {
    // Azure Database for PostgreSQL with Microsoft Entra auth: the password is a
    // short-lived access token for the app's managed identity (or your `az login`
    // locally). pg asks for it on every new connection; the credential caches it.
    const credential = new DefaultAzureCredential({ managedIdentityClientId: as?.clientId ?? process.env.AZURE_CLIENT_ID });
    config.password = async () => (await credential.getToken(ENTRA_SCOPE)).token;
  }
  return config;
}

/** Connects to Postgres, creating the database first if it doesn't exist yet. */
export async function connectPostgres(url: string, auth: DatabaseAuth = 'password', as?: ConnectAs): Promise<Database> {
  const config = poolConfig(url, auth, as);
  let pool = new pg.Pool(config);
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    if ((err as { code?: string }).code !== '3D000' || !config.database) throw err; // 3D000: database does not exist
    await pool.end();
    const admin = new pg.Client({ ...config, database: 'postgres' });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(config.database)}`);
      console.log(`Created database ${config.database}`);
    } catch (createErr) {
      // Another replica won the race: 42P04 if it finished first, 23505 if we collided mid-create.
      const code = (createErr as { code?: string }).code;
      if (code !== '42P04' && code !== '23505') throw createErr;
    } finally {
      await admin.end();
    }
    pool = new pg.Pool(config);
  }
  pool.on('error', (err) => console.error('Idle database connection failed:', err.message));

  const listeners: pg.Client[] = [];
  let closing = false;

  return {
    query: <R>(text: string, params?: unknown[]) => pool.query(text, params) as unknown as Promise<{ rows: R[] }>,

    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as Queryable);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async listen(channel, { onMessage, onReconnect }) {
      // LISTEN needs a connection of its own that stays open, outside the pool.
      let attempt = 0;
      const connect = async (isReconnect: boolean): Promise<void> => {
        const client = new pg.Client(config);
        client.on('notification', (msg) => {
          if (msg.channel === channel && msg.payload != null) onMessage(msg.payload);
        });
        client.on('error', (err) => console.error(`Listener for ${channel} failed:`, err.message));
        try {
          await client.connect();
          await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
        } catch (err) {
          await client.end().catch(() => {});
          throw err;
        }
        listeners.push(client);
        client.on('end', () => {
          listeners.splice(listeners.indexOf(client), 1);
          if (!closing) retry();
        });
        attempt = 0;
        if (isReconnect) onReconnect?.();
      };
      const retry = () => {
        const delay = Math.min(30_000, 1000 * 2 ** attempt++);
        setTimeout(() => {
          if (!closing) connect(true).catch((err) => {
            console.error(`Reconnecting listener for ${channel} failed:`, err.message);
            retry();
          });
        }, delay).unref();
      };
      await connect(false);
    },

    async close() {
      closing = true;
      await Promise.all(listeners.map((c) => c.end()));
      await pool.end();
    },
  };
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT,
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX users_username_key ON users (lower(username));
  CREATE UNIQUE INDEX users_email_key ON users (lower(email));

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  -- One-time codes that hand a Google sign-in from the API back to the browser app.
  CREATE TABLE login_codes (
    code_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE games (
    id TEXT PRIMARY KEY,
    created_by INTEGER NOT NULL REFERENCES users(id),
    white_id INTEGER REFERENCES users(id),
    black_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'finished')),
    invite_code TEXT UNIQUE,
    state JSONB,
    version INTEGER NOT NULL DEFAULT 0,
    winner_id INTEGER REFERENCES users(id),
    points INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX games_white ON games (white_id);
  CREATE INDEX games_black ON games (black_id);

  CREATE TABLE game_actions (
    id BIGSERIAL PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    action JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX game_actions_game ON game_actions (game_id);
  `,
];

/** Brings the schema up to date. Safe to run from several servers starting at once. */
export async function migrate(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7461001)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const { rows } = await tx.query<{ version: number | null }>('SELECT max(version) AS version FROM schema_migrations');
    for (let v = rows[0].version ?? 0; v < MIGRATIONS.length; v++) {
      await tx.query(MIGRATIONS[v]);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v + 1]);
    }
  });
}

/**
 * Creates the Postgres role for a managed identity (Azure Database for
 * PostgreSQL with Microsoft Entra auth) unless it exists. Must be run by a
 * Microsoft Entra administrator. The role gets no rights here; see grantAppAccess.
 */
export async function ensureEntraRole(url: string, name: string, objectId: string): Promise<void> {
  // Microsoft's pgaadauth functions live in the server's `postgres` database.
  const client = new pg.Client({ ...poolConfig(url, 'entra'), database: 'postgres' });
  await client.connect();
  try {
    // Replicas starting together take turns.
    await client.query('SELECT pg_advisory_lock(7461002)');
    const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
    if (rows.length === 0) {
      await client.query(`SELECT * FROM pgaadauth_create_principal_with_oid($1, $2, 'service', false, false)`, [name, objectId]);
      console.log(`Created database role ${name}`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Lets `role` read and write the app's rows and nothing more: it can't change
 * the schema, drop tables, or touch other databases. The API serves requests
 * as this role, so a bug in a query can't do more damage than that.
 */
export async function grantAppAccess(db: Database, role: string): Promise<void> {
  const r = pg.escapeIdentifier(role);
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7461001)');
    await tx.query(`GRANT USAGE ON SCHEMA public TO ${r}`);
    await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`);
    await tx.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r}`);
    await tx.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${r}`);
  });
}
