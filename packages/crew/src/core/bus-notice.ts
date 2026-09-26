/**
 * The `/health.warnings` notice for a daemon whose engine has no usable bus (DES-TEAMING-002 T0).
 * One place for the wording, so every failure kind reads correctly.
 */

export interface BusUnavailableNotice {
  dbPath: string;
  reason: string;
  /** What failed: crew's boot probe could not open the file, or the engine could not arm its bus
   *  bridge on the handed bus within its bound. Absent = the probe (the older shape). */
  kind?: 'probe_open' | 'bridge_not_armed';
}

export interface HealthBusWarning {
  kind: 'bus.unavailable';
  severity: 'warning';
  message: string;
}

export function busUnavailableWarning(u: BusUnavailableNotice): HealthBusWarning {
  const message =
    u.kind === 'bridge_not_armed'
      ? `bus unavailable: the engine could not arm its bus bridge on ${u.dbPath} (${u.reason}) — ` +
        'it launches nothing from the bus; find what holds the bus file locked or slow, then restart the daemon'
      : `bus unavailable: cannot open ${u.dbPath} (${u.reason}) — ` +
        'the engine runs without a bus (un-teamed); fix the path or its permissions and restart the daemon';
  return { kind: 'bus.unavailable', severity: 'warning', message };
}

export interface HealthBusSeamsOffWarning {
  kind: 'bus.seams_off';
  severity: 'warning';
  message: string;
}

/** The `/health.warnings` notice for a daemon whose engine was handed the bus at `dbPath` but has
 *  no `Core.busEmit`/`Core.busRead` (wicked-core#631): crew reaches the bus only through the
 *  engine, so every bus seam is off. */
export function busSeamsOffWarning(dbPath: string): HealthBusSeamsOffWarning {
  return {
    kind: 'bus.seams_off',
    severity: 'warning',
    message:
      `bus seams off: engine lacks busEmit/busRead (wicked-core#631) — crew's bus seams on ${dbPath} ` +
      '(interactive answering and relay, project events, team relay) are off; link a wicked-core-ts that carries them',
  };
}
