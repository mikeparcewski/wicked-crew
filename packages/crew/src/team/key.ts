// The team idempotency key, byte for byte as wicked-core's `crate::bus::deterministic_key`
// computes it (DES-TEAMING-002 §4.1): SHA-256 over every part's UTF-8 bytes followed by one 0x00
// byte (the last part is NUL-terminated too; this is not a `\0`-join), the first 16 bytes of the
// digest as lowercase hex. Crew publishes no team event (DES-002 §7); this exists so a crew-side
// reader can recompute a row's key, and so `tests/team-events.test.ts` pins the two
// implementations to the same vectors.

import { createHash } from 'node:crypto';

/** `deterministic_key(parts)`: 32 lowercase hex characters. */
export function deterministicKey(parts: readonly string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(Buffer.from(p, 'utf8'));
    h.update(Buffer.from([0]));
  }
  return h.digest().subarray(0, 16).toString('hex');
}

/** A team event's key: `deterministic_key(["team", eventType, runId, ...parts])` (DES-002 §6.1). */
export function teamKey(eventType: string, runId: string, parts: readonly string[] = []): string {
  return deterministicKey(['team', eventType, runId, ...parts]);
}
