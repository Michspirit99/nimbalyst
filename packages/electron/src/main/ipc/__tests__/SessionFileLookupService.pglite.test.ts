import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lookupSessionsForEditedFiles } from '../SessionFileLookupService';

interface PgDatabase {
  exec(sql: string): Promise<unknown>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

describe('SessionFileLookupService with PGLite', () => {
  let root: string;
  let database: PgDatabase;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-session-files-pg-'));
    database = new PGlite({ dataDir: root }) as unknown as PgDatabase;
    await database.exec(`
      CREATE TABLE session_files (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        link_type TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    for (let index = 0; index < 501; index += 1) {
      const filePath = `/repo/file-${index}.ts`;
      await database.query(
        `INSERT INTO session_files(id, session_id, workspace_id, file_path, link_type, timestamp)
         VALUES ($1, $2, $3, $4, 'edited', $5), ($6, $7, $3, $4, 'edited', $8)`,
        [`old-${index}`, `old-session-${index}`, '/repo', filePath, '2026-01-01T00:00:00Z',
          `new-${index}`, `new-session-${index}`, '2026-01-02T00:00:00Z'],
      );
    }
  });

  afterAll(async () => {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the newest edited session across multiple query chunks', async () => {
    const paths = Array.from({ length: 501 }, (_, index) => `/repo/file-${index}.ts`);
    const result = await lookupSessionsForEditedFiles(database, '/repo', paths);

    expect(result.size).toBe(501);
    expect(result.get('/repo/file-0.ts')).toBe('new-session-0');
    expect(result.get('/repo/file-500.ts')).toBe('new-session-500');
  });
});
