import type { WorkerOutput } from './types.js';

export function parseWorkerOutput(stdout: string): WorkerOutput | null {
  const trimmed = stdout.trimEnd();
  if (!trimmed) return null;

  const lines = trimmed.split('\n');

  // Try last line first (structured mode)
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isWorkerOutput(parsed)) return parsed;
    } catch {
      // not valid JSON, continue scanning
    }
  }

  return null;
}

function isWorkerOutput(v: unknown): v is WorkerOutput {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj['status'] === 'ok' || obj['status'] === 'error';
}
