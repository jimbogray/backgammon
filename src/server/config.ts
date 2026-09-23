import path from 'node:path';

export interface Config {
  port: number;
  /** Public URL of the site, used to build the Google OAuth redirect URI. */
  appUrl: string;
  databasePath: string;
  /**
   * SQLite journal mode. WAL is faster but needs shared memory, which network
   * file systems such as Azure App Service's /home share don't support.
   */
  databaseJournalMode: 'wal' | 'delete';
  isProduction: boolean;
  google: { clientId: string; clientSecret: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const isProduction = env.NODE_ENV === 'production';
  const appUrl = (env.APP_URL ?? (isProduction ? '' : 'http://localhost:5173')).replace(/\/$/, '');
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : null;
  const databaseJournalMode = (env.DATABASE_JOURNAL_MODE ?? 'wal').toLowerCase();
  if (databaseJournalMode !== 'wal' && databaseJournalMode !== 'delete') {
    throw new Error('DATABASE_JOURNAL_MODE must be "wal" or "delete"');
  }
  if (google && !appUrl) {
    throw new Error('APP_URL must be set (e.g. https://backgammon.example.com) when Google sign-in is enabled');
  }
  return {
    port,
    appUrl,
    databasePath: env.DATABASE_PATH ?? path.resolve('data', 'backgammon.db'),
    databaseJournalMode,
    isProduction,
    google,
  };
}
