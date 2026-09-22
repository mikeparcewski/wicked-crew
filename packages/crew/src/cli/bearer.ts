/**
 * Merge a `WICKED_CREW_TOKEN` bearer into a fetch `RequestInit`.
 *
 * Exported from a side-effect-free module (not from cli/index.ts, which calls main() on import)
 * so tests can verify header injection without spawning the dist CLI or triggering the daemon.
 */
export function withBearerHeader(init: RequestInit | undefined, env: NodeJS.ProcessEnv = process.env): RequestInit {
  const token = env['WICKED_CREW_TOKEN'];
  if (!token) return init ?? {};
  return {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
  };
}
