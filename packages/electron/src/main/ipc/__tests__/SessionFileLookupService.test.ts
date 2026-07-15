import { describe, expect, it, vi } from 'vitest';
import {
  lookupSessionsForEditedFiles,
  type SessionFileLookupDatabase,
} from '../SessionFileLookupService';

describe('lookupSessionsForEditedFiles', () => {
  it('passes bounded path arrays to the database and merges rows', async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => {
      const paths = params[1] as string[];
      return { rows: paths.map((file_path) => ({ file_path, session_id: `session:${file_path}` })) };
    });

    const paths = Array.from({ length: 501 }, (_, index) => `/repo/file-${index}.ts`);
    const database = { query: query as unknown as SessionFileLookupDatabase['query'] };
    const result = await lookupSessionsForEditedFiles(database, '/repo', paths);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map((call) => (call[1][1] as string[]).length)).toEqual([250, 250, 1]);
    expect(query.mock.calls.every((call) => call[1][0] === '/repo')).toBe(true);
    expect(result.size).toBe(501);
    expect(result.get('/repo/file-500.ts')).toBe('session:/repo/file-500.ts');
  });
});
