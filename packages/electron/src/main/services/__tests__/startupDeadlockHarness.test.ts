import { describe, expect, it } from 'vitest';
import {
  createDiffFixture,
  LARGE_DIFF_BYTES,
  measureEventLoop,
  yieldToEventLoop,
} from './startupDeadlockHarness';

describe('startup deadlock harness', () => {
  it('generates ordinary and highly compressible diff fixtures', () => {
    const ordinary = createDiffFixture('/repo/ordinary.ts', LARGE_DIFF_BYTES + 1);
    const compressible = createDiffFixture('/repo/compressible.ts', LARGE_DIFF_BYTES + 1, true);

    expect(ordinary.current).toBeGreaterThan(LARGE_DIFF_BYTES);
    expect(compressible.current).toBeGreaterThan(LARGE_DIFF_BYTES);
    expect(compressible.snapshot.byteLength).toBeLessThan(compressible.current.length);
  });

  it('records timer heartbeats during cooperative work', async () => {
    const { metrics } = await measureEventLoop(async () => {
      for (let index = 0; index < 20; index += 1) {
        await yieldToEventLoop();
      }
    });

    expect(metrics.heartbeatCount).toBeGreaterThanOrEqual(0);
    expect(metrics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(metrics.maxHeartbeatDelayMs).toBeGreaterThanOrEqual(0);
  });
});