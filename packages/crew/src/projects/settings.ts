/**
 * Crew-side per-project settings (DES-MERGE-001 §7.1's `interactiveRoot`).
 *
 * WHY THIS IS NOT AN ENGINE COLUMN. The engine's project row is fixed (name/description/status
 * — `adapter.projectUpdate` maps exactly those three onto the native addon), and DES-MERGE-001
 * slice 1 is a crew-side transport slice: adding a column would mean a wicked-core release on
 * the critical path of a proxy. So the setting lives here, in a small durable JSON map keyed by
 * project id, and is MERGED onto the engine's record at the route boundary — the wire shape the
 * studio sees is one `Project` with an `interactiveRoot` field, which is what §7.1 asks for and
 * what Phase C depends on. If the setting ever earns an engine column, this store becomes the
 * migration source and the wire shape does not move.
 *
 * Written atomically (tmp + rename), read tolerantly: a corrupt file costs the settings, never
 * the daemon's boot — an unreadable row simply resolves to the shared default root.
 *
 * # The file FOLLOWS `--db` (crew#353, the settings instance of crew#330's principle)
 *
 * This was the last durable store still resolving from `homedir()` unconditionally: a daemon
 * isolated with `--db $SCRATCH/core.db` read and WROTE the developer's real
 * `~/.wicked-crew/project-settings.json` — worse than the graphs crew#330 caught, because a
 * scratch daemon's PATCH could silently rewrite a real project's `interactiveRoot` binding.
 * The default path now resolves through the shared state-home seam (`state-home.ts`, the one
 * `graph-paths.ts` uses): env override, then the bootstrap-configured `--db` parent, then the
 * historical homedir default — byte-identical without `--db`.
 *
 * MIGRATION IS DELIBERATELY LOUD, NEVER SILENT. An overridden state home does NOT fall back to
 * reading the default root's file: the two stores hold bindings keyed by project ids from two
 * different core dbs, so inheriting them silently would be exactly the cross-contamination the
 * isolation exists to prevent — and silently SHADOWING them is how this class of bug hides. When
 * the override root has no settings file but the default root has one, the daemon says so at
 * boot (both paths named, copy instruction included) and starts empty at the override root.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { crewStateHome } from './state-home.js';

/** One project's crew-side settings. Nullable-by-design: null ⇒ "use the shared default". */
export interface ProjectSettings {
  /** DES-MERGE-001 §7.1 — the wicked-interactive docs root this project speaks to. */
  interactiveRoot?: string | null;
}

/**
 * Where the store lives. Precedence mirrors `projectGraphRoot` exactly: the explicit
 * `WICKED_CREW_PROJECT_SETTINGS` env override (the more specific instruction, and what the test
 * suite pins), then the daemon's state home — the `--db` parent when the bootstrap configured
 * one (crew#353), the historical `~/.wicked-crew` default otherwise.
 *
 * `onLegacyShadow` fires (once, at resolution) when the state-home path is NOT the default root,
 * holds no settings file yet, and the default root DOES hold one — the "your settings appear to
 * have vanished" moment an operator must hear about rather than debug (see the module header).
 * Deliberately NOT fired for the env override: that path is spelled explicitly per run (tests,
 * proof scripts), so shadowing there is the caller's stated intent, not a surprise.
 * `legacyPath` is injectable so the warning is testable without touching a real home directory.
 */
export function defaultSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  onLegacyShadow?: (legacyPath: string, activePath: string) => void,
  legacyPath: string = join(homedir(), '.wicked-crew', 'project-settings.json'),
): string {
  const override = env['WICKED_CREW_PROJECT_SETTINGS'];
  if (override !== undefined) return override;
  const path = join(crewStateHome(), 'project-settings.json');
  if (onLegacyShadow !== undefined && path !== legacyPath && !existsSync(path) && existsSync(legacyPath)) {
    onLegacyShadow(legacyPath, path);
  }
  return path;
}

export class ProjectSettingsStore {
  private readonly path: string;
  private readonly rows: Record<string, ProjectSettings> = {};

  constructor(path?: string, warn: (msg: string) => void = (m) => console.warn(m)) {
    this.path =
      path ??
      defaultSettingsPath(process.env, (legacy, active) =>
        warn(
          `project-settings: the state home (${dirname(active)}) has no project-settings.json, but the default ` +
            `root has one (${legacy}). This daemon starts with EMPTY project settings and will neither read nor ` +
            `write the default root's file — copy it to ${active} if this daemon should inherit those bindings (crew#353).`,
        ),
      );
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { projects?: Record<string, ProjectSettings> };
      for (const [id, row] of Object.entries(parsed?.projects ?? {})) {
        // Per-row validation, like the handoff ledger: one malformed row must not blank the map.
        if (typeof row !== 'object' || row === null) continue;
        const root = row.interactiveRoot;
        if (root === undefined || root === null || typeof root === 'string') {
          this.rows[id] = root === undefined ? {} : { interactiveRoot: root };
        }
      }
    } catch {
      // Missing or malformed — start empty. Every project then resolves to the shared default,
      // which is the correct degraded answer, not an outage.
    }
  }

  /** This project's settings; `{}` when it has never been configured. */
  get(projectId: string): ProjectSettings {
    return this.rows[projectId] ?? {};
  }

  /** Apply a patch and persist. `interactiveRoot: null` CLEARS the binding (back to shared). */
  set(projectId: string, patch: ProjectSettings): ProjectSettings {
    const next: ProjectSettings = { ...this.get(projectId), ...patch };
    if (next.interactiveRoot === null || next.interactiveRoot === undefined) delete next.interactiveRoot;
    this.rows[projectId] = next;
    this.persist();
    return next;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ projects: this.rows }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}
