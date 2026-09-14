// `api/roster-standing.ts` — the ONE roster accessor every launch path shares (F-RECON-002/003).
// Pinned here: the standing readings ride on each seat, and `engineRosterJson` (what `launchRun`
// applies) turns a signed-out seat into the engine's bench verdict. Over an injected registry and
// sign-in probe — never the native addon, never the developer's dotfiles.

import { describe, expect, it } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { chatSeatAdmission } from '../src/api/seat-standing.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { engineRosterJson } from '../src/core/engine-roster.js';

const REGISTRY = [
  { key: 'claude', display_name: 'Claude Code', binary: 'claude', enabled_for_council: true, headless_invocation: 'claude -p {PROMPT}', login_invocation: 'claude login' },
  { key: 'codex', display_name: 'Codex', binary: 'codex', enabled_for_council: true, headless_invocation: 'codex exec {PROMPT}', login_invocation: 'codex login' },
  { key: 'opencode', display_name: 'OpenCode', binary: 'opencode', enabled_for_council: true, headless_invocation: 'opencode run {PROMPT}' },
];

describe('rosterWithStandingFactory', () => {
  it('decorates every registry seat with health + signed_in + standing, read at CALL time', () => {
    const tracker = new SeatHealthTracker();
    let codexSignedIn: boolean | null = false;
    const roster = rosterWithStandingFactory({
      seatHealth: tracker,
      registry: () => REGISTRY.map((s) => ({ ...s })),
      signedIn: (key) => (key === 'codex' ? codexSignedIn : key === 'claude' ? true : null),
      env: { WICKED_WORKER_HOME: '/tmp/worker-home' },
    });
    const first = roster();
    const codex = first.find((s) => s.key === 'codex')!;
    expect(codex.auth).toBe('signed_out');
    expect(codex.council_eligible).toBe(false);
    expect(codex.signed_in).toBe(false);
    expect(codex.health).toEqual(expect.objectContaining({ status: 'active' }));
    // Registry fields ride through verbatim (the engine's login_invocation included).
    expect(codex.login_invocation).toBe('codex login');
    expect(first.find((s) => s.key === 'claude')!.council_eligible).toBe(true);
    // opencode answers on its free tier with an unknown probe.
    expect(first.find((s) => s.key === 'opencode')!.council_eligible).toBe(true);

    // The seat signs in from the System page: the very next call sees it — nothing was captured.
    codexSignedIn = true;
    expect(roster().find((s) => s.key === 'codex')!.council_eligible).toBe(true);
  });

  it('F-W1-005: every seat carries the daemon\'s chat admission verdict for BOTH scope modes — the same chatSeatAdmission the POST /chats pre-filter runs', () => {
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [
        ...REGISTRY.map((s) => ({ ...s })),
        { key: 'pi', display_name: 'Pi', binary: 'pi', enabled_for_council: true, headless_invocation: 'pi {PROMPT}', acp: { binary: 'pi-acp', acp_input_governance: false, os_sandbox: false } },
        { key: 'governed', display_name: 'Governed', binary: 'claude', enabled_for_council: true, headless_invocation: 'claude -p {PROMPT}', acp: { binary: 'claude-acp', acp_input_governance: true } },
      ],
      signedIn: (key) => (key === 'codex' ? false : true),
      env: { WICKED_WORKER_HOME: '' },
    })();
    const of = (key: string) => roster.find((s) => s.key === key)!['chat_admission'] as { unscoped: { ok: boolean; reason?: string; source?: string }; scoped: { ok: boolean; reason?: string; source?: string } };
    // No ACP adapter: sits in an unscoped chat, refused for a scoped one — with the daemon's own reason.
    expect(of('claude').unscoped).toEqual({ ok: true });
    expect(of('claude').scoped).toEqual({ ok: false, reason: expect.stringMatching(/no ACP adapter registered/), source: 'scope' });
    // Signed out: refused in BOTH modes, source auth (the reason names the remedy).
    expect(of('codex').unscoped).toEqual({ ok: false, reason: expect.stringMatching(/signed out/), source: 'auth' });
    expect(of('codex').scoped.ok).toBe(false);
    expect(of('codex').scoped.source).toBe('auth');
    // pi: an adapter that asks no permissions and arms no sandbox — unscoped yes, scoped no.
    expect(of('pi').unscoped).toEqual({ ok: true });
    expect(of('pi').scoped).toEqual({ ok: false, reason: expect.stringMatching(/asks no permissions/), source: 'scope' });
    // A governed adapter sits in both.
    expect(of('governed')).toEqual({ unscoped: { ok: true }, scoped: { ok: true } });
    // The verdict IS the pre-filter's: the same function, the same inputs.
    for (const key of ['claude', 'codex', 'pi', 'governed']) {
      const seat = roster.find((s) => s.key === key)!;
      expect(of(key).scoped).toEqual(chatSeatAdmission(seat as unknown as Parameters<typeof chatSeatAdmission>[0], seat.auth!, true));
      expect(of(key).unscoped).toEqual(chatSeatAdmission(seat as unknown as Parameters<typeof chatSeatAdmission>[0], seat.auth!, false));
    }
  });

  it('a signed-out seat reaches the ENGINE benched: health {usable:false, reason:"signed out"} (engineRosterJson, what launchRun applies)', () => {
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => REGISTRY.map((s) => ({ ...s })),
      signedIn: (key) => key !== 'codex',
      env: {},
    });
    const engine = JSON.parse(engineRosterJson(JSON.stringify(roster()))) as Array<Record<string, unknown>>;
    const codex = engine.find((s) => s['key'] === 'codex')!;
    expect(codex['health']).toEqual({ usable: false, reason: 'signed out' });
    expect(engine.find((s) => s['key'] === 'claude')!['health']).toEqual({ usable: true });
    // Crew's own readings never reach the engine.
    for (const seat of engine) {
      for (const k of ['signed_in', 'auth', 'council_eligible', 'council_ineligible_reason', 'council_bench', 'chat_admission']) {
        expect(k in seat, `${String(seat['key'])}.${k} must not reach the engine`).toBe(false);
      }
    }
  });

  it('WICKED_WORKER_HOME is read per call from the given env ("" = unset)', () => {
    const seen: Array<string | undefined> = [];
    const env: NodeJS.ProcessEnv = { WICKED_WORKER_HOME: '' };
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [REGISTRY[0]!],
      signedIn: (_key, root) => {
        seen.push(root);
        return true;
      },
      env,
    });
    roster();
    env['WICKED_WORKER_HOME'] = '/live/root';
    roster();
    expect(seen).toEqual([undefined, '/live/root']);
  });
});
