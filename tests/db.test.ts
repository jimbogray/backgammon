import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAppAccess } from '../src/server/db';
import { createTestDatabase } from './testDb';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.query('CREATE ROLE app_user');
  await grantAppAccess(db, 'app_user');
});
afterAll(async () => {
  await db.close();
});

/** Runs `sql` as app_user, returning the error message if Postgres refuses. */
async function asAppUser(sql: string): Promise<string | null> {
  try {
    await db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_user');
      await tx.query(sql);
    });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe('the API database role', () => {
  it('can read and write the app tables', async () => {
    expect(await asAppUser(`INSERT INTO users (username, email) VALUES ('alice', 'a@example.com')`)).toBeNull();
    expect(await asAppUser(`UPDATE users SET username = 'alice2' WHERE username = 'alice'`)).toBeNull();
    expect(await asAppUser(`SELECT * FROM games`)).toBeNull();
    expect(await asAppUser(`DELETE FROM sessions`)).toBeNull();
  });

  it('cannot change the schema or the migration record', async () => {
    expect(await asAppUser('DROP TABLE users CASCADE')).toMatch(/must be owner/);
    expect(await asAppUser('ALTER TABLE users ADD COLUMN x int')).toMatch(/must be owner/);
    expect(await asAppUser('CREATE TABLE sneaky (id int)')).toMatch(/permission denied/);
    expect(await asAppUser('TRUNCATE users CASCADE')).toMatch(/permission denied/);
    expect(await asAppUser('INSERT INTO schema_migrations (version) VALUES (99)')).toMatch(/permission denied/);
    expect(await asAppUser('SELECT * FROM schema_migrations')).toBeNull();
  });
});
