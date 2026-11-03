/**
 * (DES-APPS-001 §9.2-§9.3, K0/K6) The commands an Apps run's Tool units run: crew's fixed CLI, never agent code.
 *
 *   wicked-crew apps-check --publish   the publish check (`check` step of `apps-publish`): prints the consent card
 *   wicked-crew apps-produce           the produce step (after consent and QE): builds the image, prints the link
 *
 * The engine hands the unit its capability token (`WICKED_MCP_TOKEN`) and this daemon's URL (`WICKED_CREW_URL`);
 * the command posts the token to crew's route, which judges it. Exit 0 = the step passed.
 */

const STEP_DEADLINE_MS = 20 * 60 * 1000;

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function post(path: string): Promise<Answer> {
  const token = process.env['WICKED_MCP_TOKEN'] ?? '';
  const base = process.env['WICKED_CREW_URL'] ?? '';
  if (token === '' || base === '') throw new StepEnvError();
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(STEP_DEADLINE_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

class StepEnvError extends Error {}

const findingsOf = (b: Record<string, unknown>): Array<{ code?: unknown; message?: unknown }> => (Array.isArray(b['findings']) ? (b['findings'] as Array<{ code?: unknown; message?: unknown }>) : []);

const NOT_A_STEP = 'apps: this command runs as an Apps run step: WICKED_MCP_TOKEN and WICKED_CREW_URL are not set';

/** `wicked-crew apps-check --publish`; answers the exit code (0 = the check passed). */
export async function runAppsCheck(argv: string[]): Promise<number> {
  if (!argv.includes('--publish')) {
    console.error('apps-check: the turn check (without --publish) is not served by this crew yet');
    return 2;
  }
  let r: Answer;
  try {
    r = await post('/apps/publish/check');
  } catch (err) {
    console.error(err instanceof StepEnvError ? NOT_A_STEP : `apps-check: crew did not answer (${err instanceof Error ? err.name : 'error'})`);
    return 2;
  }
  if (r.status !== 200) {
    console.error(`apps-check: crew refused the publish check (${r.status} ${String(r.body['code'] ?? '')}): ${String(r.body['error'] ?? '')}`);
    for (const f of findingsOf(r.body)) console.error(`  - ${String(f.code)}: ${String(f.message)}`);
    return 1;
  }
  console.log(String(r.body['card'] ?? ''));
  const findings = findingsOf(r.body);
  if (r.body['ok'] !== true) {
    console.log('\nThe publish check FAILED:');
    for (const f of findings) console.log(`  - ${String(f.code)}: ${String(f.message)}`);
    return 1;
  }
  console.log('\nThe publish check passed.');
  return 0;
}

/** `wicked-crew apps-produce`; answers the exit code (0 = the image was built and the link recorded). */
export async function runAppsProduce(): Promise<number> {
  let r: Answer;
  try {
    r = await post('/apps/publish/produce');
  } catch (err) {
    console.error(err instanceof StepEnvError ? NOT_A_STEP : `apps-produce: crew did not answer (${err instanceof Error ? err.name : 'error'})`);
    return 2;
  }
  if (r.status !== 200) {
    console.error(`apps-produce: crew could not produce the publish (${r.status} ${String(r.body['code'] ?? '')}): ${String(r.body['error'] ?? '')}`);
    return 1;
  }
  const p = (r.body['published'] ?? {}) as { shareUrl?: string; image?: { tag?: string; id?: string }; run?: { env?: string[]; volume?: string | null; port?: number } };
  console.log(`Published. Share link: ${p.shareUrl ?? '(none)'}`);
  console.log(`Image: ${p.image?.tag ?? ''} ${p.image?.id ?? ''} (local; nothing was pushed)`);
  const env = (p.run?.env ?? []).map((e) => `-e ${e}=…`).join(' ');
  console.log(`Run it: docker run -p 8080:${p.run?.port ?? 8080} ${env}${p.run?.volume != null ? ` -v <volume>:${p.run.volume}` : ''} ${p.image?.tag ?? ''}`.replace(/\s+/g, ' '));
  return 0;
}
