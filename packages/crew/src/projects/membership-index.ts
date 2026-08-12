/**
 * The run→project index the daemon tags `/ws` frames with (DES-PROJECT-001 §5.2: "the daemon
 * tags frames with `project_id` from the membership table" — no new socket, no engine change).
 *
 * A latency layer, NOT truth: the membership table in core.db is authoritative; this map exists
 * because the tag is applied on the synchronous event fan-out path where an engine read per frame
 * is unaffordable. It hydrates once from the engine at server start and is updated by exactly the
 * route handlers that change memberships (launch-with-projectId, attach, detach) — the same
 * post-commit points that emit the bus events, so the map can only lag by a failed hydrate, never
 * diverge silently.
 */

import type { CoreAdapter } from '../core/adapter.js';

export class MembershipIndex {
  private readonly runToProject = new Map<string, string>();

  /**
   * Load every live `crew.run`/`crew.chat` membership from the engine. Best-effort: a pre-0.6.0
   * addon (no project surface) leaves the index empty — frames simply go untagged, which is the
   * pre-projects behavior, not an error.
   */
  async hydrate(adapter: CoreAdapter, log?: (msg: string) => void): Promise<void> {
    if (!adapter.projectsSupported()) return;
    try {
      const projects = await adapter.projectList();
      for (const project of projects) {
        for (const member of await adapter.projectMembers(project.id)) {
          if (member.member_kind === 'crew.run' || member.member_kind === 'crew.chat') {
            this.runToProject.set(member.member_ref, project.id);
          }
        }
      }
    } catch (err) {
      log?.(
        `[projects] membership-index hydrate failed (frames go untagged until the next write): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  set(runOrChatId: string, projectId: string): void {
    this.runToProject.set(runOrChatId, projectId);
  }

  delete(runOrChatId: string): void {
    this.runToProject.delete(runOrChatId);
  }

  projectOf(runOrChatId: string): string | undefined {
    return this.runToProject.get(runOrChatId);
  }
}
