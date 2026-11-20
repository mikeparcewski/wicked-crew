import { availableParallelism } from 'node:os';

/** Keep a valid operator override; otherwise allow engine work and I/O to share the pool. */
export function resolveThreadpoolSize(env: NodeJS.ProcessEnv, cores: number): string {
  const override = env.UV_THREADPOOL_SIZE;
  if (override !== undefined && /^\d+$/.test(override)) {
    const size = Number(override);
    if (Number.isInteger(size) && size >= 1 && size <= 1024) return override;
  }
  return String(Math.min(1024, Math.max(16, cores)));
}

// libuv fixes its pool size on first use, before the CLI body can run (crew#1495).
process.env.UV_THREADPOOL_SIZE = resolveThreadpoolSize(process.env, availableParallelism());
