import { gzipSync } from 'node:zlib';

export const LARGE_DIFF_BYTES = 2 * 1024 * 1024;

export interface EventLoopMetrics {
  elapsedMs: number;
  heartbeatCount: number;
  maxHeartbeatDelayMs: number;
}

export interface DiffFixture {
  path: string;
  current: string;
  snapshot: Buffer;
}

export function createDiffFixture(
  path: string,
  sizeBytes: number,
  highlyCompressible = false,
): DiffFixture {
  const line = highlyCompressible ? 'unchanged\n' : '0123456789abcdef\n';
  const repetitions = Math.ceil(sizeBytes / Buffer.byteLength(line));
  const current = line.repeat(repetitions).slice(0, sizeBytes);
  return { path, current, snapshot: gzipSync(Buffer.from(current)) };
}

export async function measureEventLoop<T>(work: () => Promise<T>): Promise<{ result: T; metrics: EventLoopMetrics }> {
  const startedAt = performance.now();
  let lastHeartbeat = startedAt;
  let heartbeatCount = 0;
  let maxHeartbeatDelayMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxHeartbeatDelayMs = Math.max(maxHeartbeatDelayMs, now - lastHeartbeat);
    lastHeartbeat = now;
    heartbeatCount += 1;
  }, 10);

  try {
    const result = await work();
    return {
      result,
      metrics: { elapsedMs: performance.now() - startedAt, heartbeatCount, maxHeartbeatDelayMs },
    };
  } finally {
    clearInterval(timer);
  }
}

export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
