import type { SkillManifest } from '../src/core/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GARDEN_INSTALL_COMMAND, REQUIRED_GARDEN_VERSION, pluginSourceAt, type PluginSource } from '../src/skills/plugin-source.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { SkillsSourceUnavailableError } from '../src/skills/store.js';
import { scaffold } from './support/skills-fixture.js';
import { removeScratch } from './setup/scratch.js';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) removeScratch(base);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function checkMessage(message: string, base: string): void {
  for (const place of [
    'WICKED_CREW_SKILLS_SOURCE', '~/.claude/plugins/cache/wicked-garden/wicked-garden/<version>',
    '~/.claude/plugins/wicked-garden', 'npm-global', 'launcher on PATH', 'beside the crew package',
    '~/.codex/plugins/cache/<marketplace>/wicked-garden/<version>', '$CODEX_HOME', '$CLAUDE_CONFIG_DIR',
  ]) expect(message).toContain(place);
  expect(message).toContain(`install wicked-garden >= ${REQUIRED_GARDEN_VERSION} first: ${GARDEN_INSTALL_COMMAND} (or npm i -g wicked-garden)`);
  expect(message).not.toContain(base);
  expect(message).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\Users\\|\/private\/|\/tmp\//i);
}

describe('no-source messages', () => {
  it('seed lists all five tiers using shareable paths and gives the installer/npm remedy', () => {
    const s = scaffold({ source: () => null });
    bases.push(s.base);
    let error: unknown;
    try { s.store.seed(); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(SkillsSourceUnavailableError);
    checkMessage((error as Error).message, s.base);
  });

  it('refresh lists the same sources when the installed plugin disappears', () => {
    const s = scaffold();
    bases.push(s.base);
    const source = pluginSourceAt(s.upstream);
    expect(source).not.toBeNull();
    // A replaceable fixture source exercises the normal requireSource path without real config reads.
    let active: PluginSource | null = source;
    const replacement = scaffold({ source: () => active });
    bases.push(replacement.base);
    replacement.store.seed();
    active = null;
    let error: unknown;
    try { replacement.store.refreshBaseline(replacement.store.revision()); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(SkillsSourceUnavailableError);
    checkMessage((error as Error).message, replacement.base);
  });

  it('the boot skills.fallback warning carries the same five-source remedy', async () => {
    const s = scaffold({ source: () => null });
    bases.push(s.base);
    const logs: string[] = [];
    vi.stubEnv('WICKED_SKILLS_SNAPSHOT', undefined);
    const health = await new SkillsRuntime({ store: s.store, bootSnapshot: undefined, log: (m) => logs.push(m) }).apply();
    expect(health.state).toBe('fallback');
    const finding = health.findings.find((f) => f.kind === 'skills.fallback');
    expect(finding).toBeDefined();
    checkMessage(finding!.message, s.base);
    checkMessage(logs.find((m) => m.includes('skills.fallback:'))!, s.base);
  });
});


describe('first-class source diagnostics', () => {
  it.each(['npm-global', 'codex-plugin-cache', 'installer-copy'] as const)('%s gets a source warning only for installer-copy', async (kind) => {
    const s = scaffold();
    bases.push(s.base);
    vi.stubEnv('WICKED_SKILLS_SNAPSHOT', undefined);
    const runtime = new SkillsRuntime({ store: s.store, bootSnapshot: undefined, log: () => undefined });
    await runtime.apply();
    const manifest: SkillManifest = s.store.manifest();
    manifest.baselines[manifest.baseline]!.source.kind = kind;
    // Isolate the diagnostics policy from the persisted-enum seam, which has separate ownership.
    vi.spyOn(s.store, 'manifest').mockReturnValue(manifest);
    const findings = runtime.health().findings.filter((f) => f.kind === 'skills.source');
    expect(findings).toHaveLength(kind === 'installer-copy' ? 1 : 0);
  });
});
