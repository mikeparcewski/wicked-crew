import { useCallback, useEffect, useState } from 'react';

export type Panel = 'runs' | 'coverage' | 'workflows' | 'domain' | 'policies' | 'rules' | 'repos';

const PANELS: Panel[] = ['runs', 'coverage', 'workflows', 'domain', 'policies', 'rules', 'repos'];

interface Route {
  panel: Panel;
  /** Non-null only when panel === 'runs' and a run is selected. */
  runId: string | null;
  /** True when panel === 'runs' and the launch form is open. */
  showLaunch: boolean;
}

/** Decode a URI component without throwing on malformed sequences. */
function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // malformed percent-sequence — use the raw string
  }
}

function parse(pathname: string): Route {
  const [, first = '', second = ''] = pathname.split('/');
  if ((PANELS as string[]).includes(first) && first !== 'runs') {
    return { panel: first as Panel, runId: null, showLaunch: false };
  }
  // /repo-detail without an id segment has no meaning; redirect to the
  // repositories list panel rather than falling through to the runs default.
  // (crew#65: distinct from the default fallback — repos is semantically correct.)
  if (first === 'repo-detail' && !second) {
    return { panel: 'repos', runId: null, showLaunch: false };
  }
  if (second === 'new') return { panel: 'runs', runId: null, showLaunch: true };
  if (second) return { panel: 'runs', runId: safeDecodeURIComponent(second), showLaunch: false };
  return { panel: 'runs', runId: null, showLaunch: false };
}

export function useRoute(): Route & {
  navigate: (path: string) => void;
  panelPath: (p: Panel) => string;
} {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const handler = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const navigate = useCallback((path: string) => {
    history.pushState(null, '', path);
    setPathname(path);
  }, []);

  const panelPath = useCallback((p: Panel) => (p === 'runs' ? '/' : `/${p}`), []);

  return { ...parse(pathname), navigate, panelPath };
}
