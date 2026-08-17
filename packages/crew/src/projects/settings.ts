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
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** One project's crew-side settings. Nullable-by-design: null ⇒ "use the shared default". */
export interface ProjectSettings {
  /** DES-MERGE-001 §7.1 — the wicked-interactive docs root this project speaks to. */
  interactiveRoot?: string | null;
}

export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_PROJECT_SETTINGS'] ?? join(homedir(), '.wicked-crew', 'project-settings.json');
}

export class ProjectSettingsStore {
  private readonly path: string;
  private readonly rows: Record<string, ProjectSettings> = {};

  constructor(path: string = defaultSettingsPath()) {
    this.path = path;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { projects?: Record<string, ProjectSettings> };
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
