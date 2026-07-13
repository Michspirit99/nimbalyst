import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BROWSER_TRANSCRIPT_IMAGE_DIRNAME,
  getBrowserTranscriptImageDir,
} from '../BrowserSessionHandlers';

/**
 * Normalize paths to forward slashes for cross-platform testing.
 * Windows uses backslashes, tests expect Unix-style paths.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

describe('getBrowserTranscriptImageDir', () => {
  it('stores transcript screenshots under a durable .nimbalyst subdirectory', () => {
    // Use a path that survives path.resolve() on Windows (which prefixes with drive).
    const workspacePath = path.resolve('/tmp/workspace');

    const result = normalizePath(getBrowserTranscriptImageDir(workspacePath));
    const expectedSuffix = normalizePath(path.join(workspacePath, '.nimbalyst', BROWSER_TRANSCRIPT_IMAGE_DIRNAME));
    expect(result).toBe(expectedSuffix);
  });

  it('normalizes the workspace path before joining the transcript image directory', () => {
    const workspacePath = path.resolve('/tmp/workspace/../workspace/.');

    const result = normalizePath(getBrowserTranscriptImageDir(workspacePath));
    const expectedSuffix = normalizePath(path.join(path.resolve('/tmp/workspace'), '.nimbalyst', BROWSER_TRANSCRIPT_IMAGE_DIRNAME));
    expect(result).toBe(expectedSuffix);
  });
});
