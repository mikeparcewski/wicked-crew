/**
 * The CLI's bearer: `WICKED_CREW_TOKEN`, and the one line we say when it is missing.
 *
 * Exported from a side-effect-free module (not from cli/index.ts, which calls main() on import)
 * so tests can verify header injection without spawning the dist CLI or triggering the daemon.
 *
 * The two names are one character apart with OPPOSITE meanings (#637), which is why the advice
 * below spells both out:
 *   - `WICKED_CREW_TOKEN`  (singular) — the CLIENT's bearer. This file. Sent as `Authorization`.
 *   - `WICKED_CREW_TOKENS` (plural)   — the DAEMON's token FILE path (`api/auth.ts`), i.e. who may
 *     call it. Setting it in a client shell grants the client nothing.
 * An operator who follows the documented plural gets 401 on every verb, so the plural is refused
 * loudly rather than accepted as an alias: its value is a file path, and sending a path as a bearer
 * would 401 exactly the same way, one step further from the cause.
 */

/** The client's bearer variable. */
export const CLIENT_TOKEN_ENV = 'WICKED_CREW_TOKEN';
/** The daemon's token-file variable — NOT a bearer. */
export const DAEMON_TOKENS_ENV = 'WICKED_CREW_TOKENS';

export function withBearerHeader(init: RequestInit | undefined, env: NodeJS.ProcessEnv = process.env): RequestInit {
  const token = env[CLIENT_TOKEN_ENV];
  if (!token) return init ?? {};
  return {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
  };
}

/**
 * What to print when the daemon refused the call for want of a bearer: one stderr line naming the
 * variable that was missing, and — when the near-miss is visible in this shell — that the plural
 * one that IS set is the daemon's token file, not this.
 *
 * Returns `null` when a bearer was sent: then the 401 is about the token's validity or scope, and
 * naming the variable would be misleading.
 */
function missingBearerAdviceFor(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[CLIENT_TOKEN_ENV]) return null;
  const head = `wicked-crew: the daemon requires auth and this CLI sent no bearer — set ${CLIENT_TOKEN_ENV}=<token from your tokens.json>`;
  if (env[DAEMON_TOKENS_ENV]) {
    return `${head}. Note ${DAEMON_TOKENS_ENV} (plural, set here) is the DAEMON's token-file path, not the client's bearer.`;
  }
  return `${head} (${DAEMON_TOKENS_ENV}, plural, is a different thing: the daemon's token-file path).`;
}

/** Said at most once per process: a bearer-less shell would otherwise repeat it on every verb. */
let adviceSaid = false;

/**
 * A 401/403 from the daemon when this CLI sent no bearer is the silent failure #637 is about: an
 * operator who set the documented plural variable gets 401 on every verb with nothing naming the
 * cause. Say the cause ONCE per process, then let the caller's own non-2xx line report the status.
 *
 * Returns the line it said, or `null` when it said nothing (a bearer WAS sent, the status is not a
 * refusal, or it has already spoken).
 */
export function warnIfUnauthorizedWithoutBearer(
  status: number,
  env: NodeJS.ProcessEnv = process.env,
  say: (line: string) => void = (line) => console.error(line),
): string | null {
  if (status !== 401 && status !== 403) return null;
  if (adviceSaid) return null;
  const advice = missingBearerAdviceFor(env);
  if (advice === null) return null;
  adviceSaid = true;
  say(advice);
  return advice;
}

/** The advice text without the once-per-process latch — for docs, tests and other callers. */
export function missingBearerAdvice(env: NodeJS.ProcessEnv = process.env): string | null {
  return missingBearerAdviceFor(env);
}

/** Test seam: the latch is process state, so a suite asserting "once" must be able to reset it. */
export function resetBearerAdviceLatch(): void {
  adviceSaid = false;
}
