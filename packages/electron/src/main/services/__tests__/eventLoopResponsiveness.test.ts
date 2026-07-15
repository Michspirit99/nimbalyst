import { describe, expect, it } from 'vitest';

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('event-loop responsiveness benchmark', () => {
  it('continues servicing heartbeats while processing many bounded jobs', async () => {
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
    }, 5);

    const startedAt = performance.now();
    for (let index = 0; index < 100; index += 1) {
      // Model bounded synchronous work without making this test dependent on
      // machine-specific CPU speed.
      const deadline = performance.now() + 1;
      while (performance.now() < deadline) {
        // Intentionally yield only after each bounded unit of work.
      }
      await yieldToEventLoop();
    }
    const elapsedMs = performance.now() - startedAt;
    clearInterval(heartbeat);

    expect(heartbeats).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});