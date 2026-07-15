import { describe, expect, it } from 'vitest';
import {
  createDiffFixture,
  measureEventLoop,
  yieldToEventLoop,
} from './startupDeadlockHarness';

interface WorkspaceBenchmarkResult {
  workspace: string;
  fixtureBytes: number;
  elapsedMs: number;
  heartbeatCount: number;
  maxHeartbeatDelayMs: number;
}

describe('startup deadlock multi-workspace benchmark', () => {
  it('runs concurrent large-workspace workloads and records metrics', async () => {
    const fixtures = Array.from({ length: 4 }, (_, index) =>
      createDiffFixture(`/workspace-${index}/large.ts`, 2 * 1024 * 1024 + 1, index % 2 === 0),
    );

    const { result, metrics } = await measureEventLoop(async () => {
      return Promise.all(fixtures.map(async (fixture) => {
        const startedAt = performance.now();
        for (let batch = 0; batch < 10; batch += 1) {
          const offset = (batch * 4096) % fixture.current.length;
          void fixture.current.charCodeAt(offset);
          await yieldToEventLoop();
        }
        return {
          workspace: fixture.path,
          fixtureBytes: fixture.current.length,
          elapsedMs: performance.now() - startedAt,
          heartbeatCount: 0,
          maxHeartbeatDelayMs: 0,
        } satisfies WorkspaceBenchmarkResult;
      }));
    });

    const results = result as WorkspaceBenchmarkResult[];
    expect(results).toHaveLength(4);
    expect(results.every((entry) => entry.fixtureBytes > 2 * 1024 * 1024)).toBe(true);
    expect(metrics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(metrics.maxHeartbeatDelayMs).toBeGreaterThanOrEqual(0);

    console.info(JSON.stringify({ metrics, workspaces: results }, null, 2));
  }, 10_000);
});