/**
 * (studio#1150) The ONE decision about a launch's human gates: whether it runs in power mode, which
 * `humanConfirm` the engine keeps, whether it delivers and whether delivery waits for a person.
 *
 * `POST /runs` hands the engine exactly this, and `POST /runs/preview` answers exactly this for the
 * same body, so a launch form can show the gates the run will keep instead of modelling crew's rules
 * (studio#1176 modelled them in the browser and drifted six times: the setting, the preset list,
 * engine support, the hand-off).
 *
 * The rules (unchanged from the launch route they were lifted out of):
 * - POWER (program DES-POWER-MODE, operator ruling 2026-10-29) is the default way a job runs: the
 *   launch's own `power`, else the `powerModeDefault` setting (on when unset) — read only when the
 *   launch did not say and it is a repo-scoped plan or workflow launch. Only a repo-scoped plan or
 *   PRESET launch runs as one orchestrator session, and only on an engine that carries it; anything
 *   else runs phased, said in `powerNotice`. A chat job's power Start (`powerRequired`) is refused
 *   instead of run phased. A power run has no plan-approval gate: its `humanConfirm` is `none`, and a
 *   posture the launch named is reported dropped (`humanConfirmNotice`).
 * - DELIVER (crew#393): explicit `pr`/`none` wins; omitted + repo-scoped + a code-work workflow is the
 *   daemon's `deliverDefault`; otherwise `none` (`resolvedDeliver`). What the engine is handed
 *   (`deliver`) is that, except where the daemon's own preparation of the launch removes delivery
 *   afterwards (a change review, a hand-launched run review); the launch route does that removal where
 *   it always did, after the revision preflight.
 * - Only an explicit `deliverGate: 'auto'` delivers without a person (F-E2E-030).
 */

/** The launch body fields the decision reads (a subset of `LaunchSchema`). */
export interface PostureBody {
  power?: boolean | undefined;
  repoRef?: string | undefined;
  workflow?: string | undefined;
  plan?: unknown;
  projectId?: string | undefined;
  humanConfirm?: string | undefined;
  deliver?: 'pr' | 'none' | undefined;
  deliverGate?: 'human' | 'auto' | undefined;
}

/** What the daemon knows, read lazily (each only when the rule needs it, as the launch always did). */
export interface PostureFacts {
  /** `settings.powerModeDefault`, on when unset. */
  powerModeDefault: () => Promise<boolean>;
  /** The workflow names a preset the engine resolves (in the project's scope). */
  namesPreset: (workflow: string, projectId: string | undefined) => Promise<boolean>;
  /** The linked engine runs power mode. */
  powerSupported: () => boolean;
  /** Omitted `deliver` on a repo-scoped workflow launch: `pr` when the def does code work and the
   *  `deliverDefault` setting is not `none`. */
  deliverDefault: (workflow: string) => Promise<'pr' | 'none'>;
  /** The daemon's preparation of this workflow's launch removes its delivery (a change review; a run review
   *  prepared by `reviewLaunch`). */
  preparationDropsDelivery: (workflow: string) => boolean;
  /** (J6 K1) The preset's steps all run as host tools (`executor.type: "tool"`): there is no agent session to lead
   *  in power mode (`domain-extraction`). Absent: no preset is. */
  toolOnly?: (workflow: string, projectId: string | undefined) => Promise<boolean>;
}

export interface LaunchPosture {
  /** The run is launched in power mode. */
  power: boolean;
  /** The posture the engine is handed (`undefined`: none sent, the engine's default). */
  humanConfirm?: string;
  /** What the engine is handed (after the daemon's own preparation of the launch). */
  deliver: 'pr' | 'none';
  /** The crew#393 resolution, before that preparation: what the launch route sets, preflights a revision
   *  against and audits. */
  resolvedDeliver: 'pr' | 'none';
  /** `resolvedDeliver` was the daemon's choice, not the launch's. */
  deliverDefaulted: boolean;
  /** Delivery follows verify with no person (`deliverGate: 'auto'`). */
  autoDeliver: boolean;
  /** Power was wanted and the launch runs phased: why. */
  powerNotice: string | null;
  /** A power run dropped the posture the launch named. */
  humanConfirmNotice: string | null;
  /** `powerRequired` and the launch would run phased: the 409 `power_unavailable` error. */
  powerRefusal: string | null;
}

export async function launchPosture(
  b: PostureBody,
  facts: PostureFacts,
  opts: { powerRequired?: boolean | undefined } = {},
): Promise<LaunchPosture> {
  // DELIVER
  let deliver: 'pr' | 'none';
  let deliverDefaulted = false;
  if (b.deliver !== undefined) {
    deliver = b.deliver;
  } else if (b.repoRef !== undefined && b.workflow !== undefined) {
    deliver = await facts.deliverDefault(b.workflow);
    deliverDefaulted = true;
  } else {
    deliver = 'none';
    deliverDefaulted = true;
  }

  // POWER
  let power = false;
  let humanConfirm = b.humanConfirm;
  let powerNotice: string | null = null;
  let humanConfirmNotice: string | null = null;
  let powerRefusal: string | null = null;
  const powerWanted = b.power ?? (b.repoRef !== undefined && (b.workflow !== undefined || b.plan !== undefined)
    ? await facts.powerModeDefault()
    : false);
  if (powerWanted) {
    // A plan, or a workflow the engine resolves to a PRESET (a registered def is planned the legacy way
    // and has no orchestrator build): only those run in power mode, so only those lose run-level gates.
    const isPreset = b.plan !== undefined || (b.workflow !== undefined && await facts.namesPreset(b.workflow, b.projectId));
    if (b.repoRef === undefined || !isPreset) {
      powerNotice = 'power mode runs a repo-scoped plan or preset launch; this launch runs phased';
    } else if (b.workflow !== undefined && facts.toolOnly !== undefined && await facts.toolOnly(b.workflow, b.projectId)) {
      // (J6 K1) A preset of host tool steps only (domain-extraction) has no session to run in power mode.
      powerNotice = 'its steps run as host tools, with no agent session to lead; the launch runs phased';
    } else if (!facts.powerSupported()) {
      powerNotice = 'this engine has no power mode; the launch runs phased';
    } else if (opts.powerRequired === true && (await facts.powerModeDefault()) === false) {
      // A chat job's power Start follows the setting up to the engine call (it may have been turned off meanwhile).
      powerNotice = 'Power mode for new jobs is off on this daemon; the launch runs phased';
    }
    // A chat job's power Start is never run phased in its place (the person chose no plan review for a power run).
    if (powerNotice !== null && opts.powerRequired === true) {
      powerRefusal = `${powerNotice.replace(/; this launch runs phased|; the launch runs phased/u, '')}; press Start with Review plan on`;
    }
    if (powerNotice === null) {
      power = true;
      // (studio#1150) A power run asks once, at hand-off: a posture the launch named is not kept — and the answer says so.
      if (humanConfirm !== undefined && humanConfirm !== 'none') {
        humanConfirmNotice = `power mode asks once, at hand-off: humanConfirm ${humanConfirm} is not kept (launch with power: false to keep it)`;
      }
      humanConfirm = 'none';
    }
  }
  return {
    power,
    ...(humanConfirm !== undefined ? { humanConfirm } : {}),
    deliver: b.workflow !== undefined && facts.preparationDropsDelivery(b.workflow) ? 'none' : deliver,
    resolvedDeliver: deliver,
    deliverDefaulted,
    autoDeliver: b.deliverGate === 'auto',
    powerNotice,
    humanConfirmNotice,
    powerRefusal,
  };
}
