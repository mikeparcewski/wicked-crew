// F35: the routes read one run through `adapter.runView(id)` and the seat record through
// `adapter.runViewsSnapshot()`, not by scanning `sessionsDetail()`. A test's fake adapter (or a real
// one whose `sessionsDetail` the test replaced) answers both from its own `sessionsDetail`, read at
// call time, so a test that swaps its views mid-way is still served what it set.
import type { SessionView } from '../../src/core/types.js';

export function withRunViews<T>(adapter: T): T {
  const a = adapter as unknown as {
    sessionsDetail?: () => Promise<SessionView[]>;
    runView?: (id: string) => Promise<SessionView | undefined>;
    runViewsSnapshot?: () => Promise<{ views: readonly SessionView[] }>;
  };
  a.runView = async (id) => (await a.sessionsDetail!()).find((v) => v.session.id === id);
  a.runViewsSnapshot = async () => ({ views: await a.sessionsDetail!() });
  return adapter;
}
