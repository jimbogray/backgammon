import { PGlite } from '@electric-sql/pglite';
import { Database, migrate, Queryable } from '../src/server/db';

type PGliteLike = Pick<PGlite, 'query' | 'exec'>;

function queryable(pg: PGliteLike): Queryable {
  return {
    async query<R>(text: string, params?: unknown[]) {
      if (params?.length) return (await pg.query<R>(text, params)) as { rows: R[] };
      // Multi-statement SQL (migrations) needs exec; return the last statement's rows.
      const results = await pg.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as R[] };
    },
  };
}

/** Postgres compiled to WebAssembly, in memory: the real SQL dialect without a server. */
export async function createTestDatabase(): Promise<Database & { reset(): Promise<void> }> {
  const pg = new PGlite();
  const db: Database & { reset(): Promise<void> } = {
    ...queryable(pg),
    transaction: (fn) => pg.transaction((tx) => fn(queryable(tx))),
    async listen(channel, { onMessage }) {
      await pg.listen(channel, onMessage);
    },
    close: () => pg.close(),
    async reset() {
      await pg.exec('TRUNCATE users, sessions, login_codes, games, game_actions RESTART IDENTITY CASCADE');
    },
  };
  await migrate(db);
  return db;
}
