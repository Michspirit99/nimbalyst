import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { lookupSessionsForEditedFiles } from '../SessionFileLookupService';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');

describe('SessionFileLookupService with SQLite', () => {
  let root: string;
  let database: SQLiteDatabase;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-session-files-'));
    database = new SQLiteDatabase({ dbDir: path.join(root, 'db'), schemaDir: SCHEMA_DIR });
    await database.initialize();
    const handle = database.getRawHandle()!;
    const insert = handle.prepare(
      `INSERT INTO session_files(id, session_id, workspace_id, file_path, link_type, timestamp)
       VALUES (?, ?, ?, ?, 'edited', ?)`,
    );
    for (let index = 0; index < 501; index += 1) {
      const filePath = `/repo/file-${index}.ts`;
      insert.run(`old-${index}`, `old-session-${index}`, '/repo', filePath, '2026-01-01T00:00:00.000Z');
      insert.run(`new-${index}`, `new-session-${index}`, '/repo', filePath, '2026-01-02T00:00:00Z');
    }
  });

  afterEach(async () => {
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