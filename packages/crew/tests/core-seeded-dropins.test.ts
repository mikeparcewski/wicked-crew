// FINDING-084: every workflow core seeds must be listed in `CORE_SEEDED_WORKFLOWS`, or crew
// overwrites core's def with its own mirror.
//
// The mechanism, precisely: crew writes a builtin overlay for any launched workflow NOT in that set.
// A file in `~/.config/wicked-core/workflows/<id>.json` REPLACES core's def wholesale — `register`
// overwrites by id and `load_dir` runs after `with_defaults()`. So an id missing from the set is an
// id whose gates crew silently owns.
//
// It happened. `domain-extraction` was absent, and crew's mirror carried a `validator_pin` copied
// from core at some past moment. A governed run was observed gating on `4a4b10bf4277bd34` — the
// PRE-substance-rule validator — long after core had moved to `e7f84b91d030fdcc`. Worse than stale:
// SELF-RESTORING, because the write runs again on the next launch, so fixing the installed file by
// hand lasts until the next registration.
//
// Core's `carry_shadowed_pins` is the backstop for compiled built-ins — it carries a shadowed pin
// forward. It cannot help for a DROP-IN, which has no compiled form to shadow and therefore no
// earlier pin to carry. That is why FINDING-049's fix did not cover this case, and why the rule has
// to be checked against core's `workflows/` directory rather than reasoned about.
//
// This is the P1 rule the ecosystem already applies elsewhere (`lockstep.rs`): a value that must
// agree across two artifacts is either derived from one source, or asserted equal by a test that
// reads BOTH. A comment asking the next person to remember is neither.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Core checked out as a sibling — the layout crew's CI uses to build the engine from source. */
function coreWorkflowsDir(): string | null {
  const candidates = [
    resolve(HERE, '../../../../wicked-core/workflows'),
    resolve(HERE, '../../../../../wicked-core/workflows'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The set as the adapter declares it, read from source so the test cannot drift from the value. */
function declaredSet(): Set<string> {
  const src = readFileSync(join(HERE, '../src/core/adapter.ts'), 'utf8');
  const block = /const CORE_SEEDED_WORKFLOWS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!block) throw new Error('CORE_SEEDED_WORKFLOWS not found — renamed or restructured?');
  return new Set([...block[1].matchAll(/'([a-zA-Z0-9._-]+)'/g)].map((m) => m[1]));
}

describe('CORE_SEEDED_WORKFLOWS covers everything core seeds', () => {
  it('lists every drop-in shipped in core/workflows', () => {
    const dir = coreWorkflowsDir();
    if (!dir) {
      // Skipping loudly rather than passing quietly: a sibling checkout is a CI property, and a
      // silent pass here would be the "green because it never ran" failure this repo already fixed
      // once (FINDING-072).
      console.warn('[core-seeded-dropins] no sibling wicked-core checkout — check NOT performed');
      return;
    }
    const seeded = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).id as string)
      .filter(Boolean);

    expect(seeded.length, 'core shipped no drop-ins — the fixture moved').toBeGreaterThan(0);

    const declared = declaredSet();
    const missing = seeded.filter((id) => !declared.has(id));
    expect(
      missing,
      `core seeds ${missing.join(', ')} but CORE_SEEDED_WORKFLOWS omits them — crew will overwrite ` +
        `core's def (and its validator_pin) for each on the next launch (FINDING-084)`,
    ).toEqual([]);
  });

  it('still lists the compiled built-ins that predate the drop-ins', () => {
    // These are seeded from Rust, not from workflows/, so the directory scan above cannot see them.
    // Losing one would reopen FINDING-049 exactly.
    const declared = declaredSet();
    for (const id of ['collab', 'onboarding']) {
      expect(declared.has(id), `${id} dropped out of CORE_SEEDED_WORKFLOWS`).toBe(true);
    }
  });
});
