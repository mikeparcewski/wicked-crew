/**
 * THEME PROPOSALS (DES-CHAT-ARTIFACTS-001 §9, slice A7; operator decision §15.2: no governed run).
 *
 * A theme proposal is a partial patch of studio's appearance (`ThemePatchSchema`, resolved in `chat-proposals.ts`).
 * Studio previews it on one tab, measures its contrast on a rendered probe, and applies it through its own appearance
 * store (`PUT /settings`, `studio.appearance`). Only after that save succeeds does studio answer the proposal Go, with
 * the delta it applied as the `edits` (`name`, `patch`), so the chat's record and the audit say exactly what changed.
 *
 * This launcher is what makes `theme` an operation crew can accept: nothing starts. There is no engine run to find or
 * adopt, nothing is live (a theme never makes the chat or a document busy), and the decided record is the record.
 */

import type { ProposalDispatch, ProposalDispatcher } from './chat-proposals.js';

export class ThemeLauncher implements ProposalDispatcher {
  /** No run is ever started, so none exists to adopt: a repeated Go is answered by the decided record under the
   *  proposal's lock (`ChatProposals.decide`), never by a second launch. */
  async find(): Promise<boolean> {
    return false;
  }

  /** Nothing to start: the person already applied the patch in studio (§9). Refuses any other kind, so a wrong
   *  registration can never record a document or a demo as started. */
  async launch(dispatch: ProposalDispatch): Promise<void> {
    if (dispatch.kind !== 'theme' || dispatch.resolution.theme === undefined) {
      throw new Error(`the theme launcher takes only a theme proposal (got ${dispatch.kind})`);
    }
  }

  /** A theme is never a live job. */
  async live(): Promise<boolean> {
    return false;
  }
}
