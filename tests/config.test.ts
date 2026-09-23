import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';

describe('loadConfig', () => {
  it('defaults the SQLite journal mode to WAL', () => {
    expect(loadConfig({}).databaseJournalMode).toBe('wal');
  });

  it('accepts delete journal mode in any case', () => {
    expect(loadConfig({ DATABASE_JOURNAL_MODE: 'DELETE' }).databaseJournalMode).toBe('delete');
  });

  it('rejects unknown journal modes', () => {
    expect(() => loadConfig({ DATABASE_JOURNAL_MODE: 'truncate' })).toThrow(/DATABASE_JOURNAL_MODE/);
  });
});
