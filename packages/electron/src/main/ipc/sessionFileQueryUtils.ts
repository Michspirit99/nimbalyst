export const SESSION_FILE_QUERY_CHUNK_SIZE = 250;

export interface SessionFileQueryRow {
  session_id: string;
  file_path: string;
}

export type SessionFileQuery = (paths: string[]) => Promise<SessionFileQueryRow[]>;

/** Split file-path candidates into bounded database query batches. */
export function chunkSessionFilePaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < paths.length; offset += SESSION_FILE_QUERY_CHUNK_SIZE) {
    chunks.push(Array.from(paths.slice(offset, offset + SESSION_FILE_QUERY_CHUNK_SIZE)));
  }
  return chunks;
}

/** Execute bounded file queries and combine their per-file session mappings. */
export async function querySessionsForFilePaths(
  paths: readonly string[],
  query: SessionFileQuery,
): Promise<Map<string, string>> {
  const fileToSession = new Map<string, string>();
  for (const pathsChunk of chunkSessionFilePaths(paths)) {
    const rows = await query(pathsChunk);
    for (const row of rows) {
      fileToSession.set(row.file_path, row.session_id);
    }
  }
  return fileToSession;
}