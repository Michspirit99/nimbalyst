import { querySessionsForFilePaths } from './sessionFileQueryUtils';

export interface SessionFileLookupDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export async function lookupSessionsForEditedFiles(
  database: SessionFileLookupDatabase,
  workspacePath: string,
  candidatePaths: readonly string[],
): Promise<Map<string, string>> {
  return querySessionsForFilePaths(candidatePaths, async (pathsChunk) => {
    const { rows } = await database.query<{ session_id: string; file_path: string }>(
      `SELECT session_id, file_path FROM (
         SELECT session_id, file_path,
                ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY timestamp DESC) AS rn
         FROM session_files
         WHERE workspace_id = $1
           AND link_type = 'edited'
           AND file_path = ANY($2::text[])
       ) ranked WHERE rn = 1`,
      [workspacePath, pathsChunk],
    );
    return rows;
  });
}
