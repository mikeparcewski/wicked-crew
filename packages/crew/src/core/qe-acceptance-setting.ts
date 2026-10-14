/**
 * The daemon-wide QE acceptance setting (`SystemSettings.qeAcceptance`, api-types 0.120.0).
 *
 * `'required'` (the shipped default, and what an absent key reads as): a run whose workflow requires
 * `qe_acceptance` delivers only on an attributed PASS, unless its own launch skips it with a reason.
 * `'off'`: the operator turned QE acceptance off for this daemon. Every launch of a workflow that
 * requires it, and that neither skips nor forces it itself, is SKIPPED through the engine's own skip
 * (`LaunchOptions.skipQeAcceptanceReason`) with a reason naming this setting. So the run, every gate
 * and the delivery stay labelled ("QE acceptance skipped by operator: …"), and the deliver gate and a
 * post-hoc lift read a skip, never a refusal. A launch's explicit `forceQeAcceptance` still wins.
 *
 * Only a workflow that requires QE acceptance gets the skip: the engine refuses a skip on any other
 * run (wicked-core `assurance.rs` `with_qe_override`: "there is nothing to skip").
 */

import type { WorkflowDef } from 'wicked-crew-api-types';

/** The contract token whose enforcement the engine leaves to the launcher. */
export const QE_ACCEPTANCE = 'qe_acceptance';

/** The engine's BUILT-IN presets that require `qe_acceptance` — the mirror of wicked-core's
 *  `catalog::builtin_preset_instruments` (QE-IN-APP-WORKFLOWS). A launch naming one of these runs the
 *  preset, whatever def of the same name crew holds. */
export const QE_PRESETS: ReadonlySet<string> = new Set([
  'feature',
  'migration',
  // core-ts 0.8.2: X-MIG M1 (`bug`, wicked-core#864) and M12 (`mcp-server`, #866) made these
  // built-in presets with qe_acceptance (codex r3 on crew A: without them an unattended delivery
  // of a bug fix pushed past the verdict check).
  'bug',
  'mcp-server',
  // wicked-core catalog.rs builtin_preset_instruments (core-ts 0.10.0): the editor-plugin workflow
  // changes the application too.
  'editor-plugin',
]);

export type QeAcceptanceMode = 'required' | 'off';

/** The setting as read: anything but `'off'` is `'required'` (fail closed). */
export function qeAcceptanceMode(settings: { qeAcceptance?: unknown } | null | undefined): QeAcceptanceMode {
  return settings?.qeAcceptance === 'off' ? 'off' : 'required';
}

/** The reason a launch skipped under the setting carries (the engine prefixes "QE acceptance skipped by operator: "). */
export const QE_OFF_REASON = "QE acceptance is off on this daemon (Settings: QE acceptance off, qeAcceptance: 'off')";

/** Where the predicate reads a workflow name from: the def crew serves under it and, when the
 *  engine has presets, the preset it resolves to for the launch's project (`CoreAdapter.presetNamed`). */
export interface QeWorkflowSource {
  getWorkflow: (id: string) => Pick<WorkflowDef, 'required_instruments'> | null | undefined;
  presetNamed?: (name: string, projectId?: string) => Promise<{ name: string; created_by: string; [k: string]: unknown } | null>;
}

/** Whether a def or a stored preset declares `qe_acceptance`. */
function declaresQe(instruments: unknown): boolean {
  return Array.isArray(instruments) && instruments.includes(QE_ACCEPTANCE);
}

/**
 * Whether a launch of `workflow` (filed in `projectId`) requires QE acceptance, resolved the way the
 * engine resolves it (wicked-core `preset::required_instruments`): a PRESET of that name wins over a
 * def — a built-in by the engine's own table (mirrored by {@link QE_PRESETS}), a saved one by its
 * `required_instruments`; otherwise the def's `required_instruments`. No workflow (free text, or a
 * launch with its own plan — the engine refuses a plan beside a workflow): nothing requires it. A
 * preset read that fails falls back to the built-in table and the def (the engine refuses a skip
 * where there is nothing to skip, so a wrong guess fails loudly at launch, never silently).
 */
export async function launchRequiresQe(src: QeWorkflowSource, workflow: string | undefined, projectId?: string): Promise<boolean> {
  if (workflow === undefined) return false;
  if (typeof src.presetNamed === 'function') {
    try {
      const preset = await src.presetNamed(workflow, projectId);
      if (preset !== null) return preset.created_by === 'builtin' ? QE_PRESETS.has(preset.name) : declaresQe(preset['required_instruments']);
    } catch {
      /* the fallback below */
    }
  }
  if (QE_PRESETS.has(workflow)) return true;
  return declaresQe(src.getWorkflow(workflow)?.required_instruments);
}

/**
 * The CONSERVATIVE reading, for the one place a wrong "no" is unsafe — unattended delivery
 * (`deliverGate: 'auto'`): QE acceptance may be required if the preset resolution says so OR the
 * name is a built-in QE preset OR the def declares it. A project preset can shadow a built-in and be
 * deleted between this check and the engine's own resolution, so "the preset says no" alone never
 * lets a QE workflow deliver unattended (codex r2 on the crew PR).
 */
export function mayRequireQe(src: Pick<QeWorkflowSource, 'getWorkflow'>, workflow: string | undefined, resolved: boolean): boolean {
  if (resolved) return true;
  if (workflow === undefined) return false;
  return QE_PRESETS.has(workflow) || declaresQe(src.getWorkflow(workflow)?.required_instruments);
}

/**
 * The skip reason the setting adds to one launch, or `undefined` when it adds none: the setting is
 * `'required'`, the launch already skips or forces QE acceptance, or its workflow does not require it.
 */
export function qeSettingSkipReason(
  mode: QeAcceptanceMode,
  launch: { skipQeAcceptanceReason?: string | undefined; forceQeAcceptance?: boolean | undefined },
  requiresQe: boolean,
): string | undefined {
  if (mode !== 'off' || !requiresQe) return undefined;
  if (launch.skipQeAcceptanceReason !== undefined || launch.forceQeAcceptance === true) return undefined;
  return QE_OFF_REASON;
}
