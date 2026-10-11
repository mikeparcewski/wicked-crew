// X-MIG M11: `POST /workflows` is retired (410 — a user saves a preset). The integration suites
// that need a scenario-specific def register it as a RUNTIME def, the way crew's own seams do
// (`adapter.registerWorkflow`: engine-validated, in memory, nothing on disk). The answer keeps the
// route's old `{status, body}` shape so each suite's assertions read as they did.
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { WorkflowDef } from '../../src/core/types.js';

export async function registerDef(
  adapter: Pick<CoreAdapter, 'registerWorkflow'>,
  def: unknown,
): Promise<{ status: number; body: { id?: string; status?: string; error?: string } }> {
  try {
    const id = await adapter.registerWorkflow(def as WorkflowDef);
    return { status: 201, body: { id, status: 'registered' } };
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
