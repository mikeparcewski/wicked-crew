/**
 * Turn the base skill OFF for a daemon that boots over a scratch HOME with NO published skills
 * generation. `baseSkillPolicy: 'require'` is the only policy since crew 0.7.35 (DES-L4 PR-⑧, D-8 /
 * D-8b): such a daemon REFUSES every launch at intake — `POST /runs` → 422 `base_skill_refused` —
 * which is exactly the product behaviour F-RC1-045 asked for (never a silently UNGROUNDED seat).
 * The suites that call this are about run mechanics (gates, bridges, campaigns, delivery), not
 * grounding, so they say so the way an operator does: `baseSkillRef: ""` — the ONE off switch —
 * written into the hermetic settings file (`WICKED_CREW_SYSTEM_SETTINGS`, tests/setup/hermetic-home.ts)
 * BEFORE `createServer` reads it at boot. Anything already in that file is kept.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { settingsFilePath } from '../../src/core/adapter.js';

export function baseSkillOff(): void {
  const file = settingsFilePath();
  mkdirSync(dirname(file), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {}; // an unreadable file is rewritten — the loader would have fallen back to the defaults anyway
    }
  }
  writeFileSync(file, JSON.stringify({ ...existing, baseSkillRef: '' }));
}
