import { describe, expect, it } from 'vitest';
import {
  chunkSessionFilePaths,
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

  it('does not mutate the input and handles empty input', () => {
    const paths = ['a.ts', 'b.ts'];
    const original = [...paths];

    expect(chunkSessionFilePaths(paths)).toEqual([paths]);
    expect(chunkSessionFilePaths([])).toEqual([]);
    expect(paths).toEqual(original);
  });
});