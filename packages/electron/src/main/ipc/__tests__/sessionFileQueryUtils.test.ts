import { describe, expect, it } from 'vitest';
import {
  chunkSessionFilePaths,
  querySessionsForFilePaths,
  SESSION_FILE_QUERY_CHUNK_SIZE,
} from '../sessionFileQueryUtils';

describe('chunkSessionFilePaths', () => {
  it('keeps large workspaces below the database query bound', () => {
    const paths = Array.from({ length: 5001 }, (_, index) => `file-${index}.ts`);
    const chunks = chunkSessionFilePaths(paths);

    expect(chunks).toHaveLength(Math.ceil(paths.length / SESSION_FILE_QUERY_CHUNK_SIZE));
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(SESSION_FILE_QUERY_CHUNK_SIZE);
    expect(chunks.flat()).toEqual(paths);
  });

  it('executes bounded queries and merges returned file mappings', async () => {
    const paths = Array.from({ length: 501 }, (_, index) => `file-${index}.ts`);
    const queriedChunks: string[][] = [];

    const result = await querySessionsForFilePaths(paths, async (chunk) => {
      queriedChunks.push(chunk);
      return chunk.map((filePath) => ({ file_path: filePath, session_id: `session-${filePath}` }));
    });

    expect(queriedChunks.map((chunk) => chunk.length)).toEqual([250, 250, 1]);
    expect(result.size).toBe(paths.length);
    expect(result.get('file-500.ts')).toBe('session-file-500.ts');
  });

  it('does not mutate the input and handles empty input', () => {
    const paths = ['a.ts', 'b.ts'];
    const original = [...paths];

    expect(chunkSessionFilePaths(paths)).toEqual([paths]);
    expect(chunkSessionFilePaths([])).toEqual([]);
    expect(paths).toEqual(original);
  });
});
