/**
 * Standing orders — the seat's parse of plain words into a rule (behaviour 10).
 *
 * ONE seat, ONE turn: an unscoped chat in a scratch directory, the prompt, the first `chatReply`
 * for that chat, then the chat is closed and the scratch removed. The answer is a proposal the
 * person confirms — crew stores only the confirmed rule — so a seat that answers badly costs a
 * retry, never a wrong order.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent, RosterSeat } from '../core/types.js';
import { parsePrompt, ruleFromAnswer, type ParseOutcome } from './routes.js';

export interface SeatParserDeps {
  adapter: Pick<CoreAdapter, 'chatOpen' | 'chatSend' | 'chatClose' | 'onEvent' | 'projectsSupported' | 'projectList'>;
  roster: () => RosterSeat[];
  /** How long the seat has to answer (default 120 s). */
  timeoutMs?: number;
}

/** The first seat the daemon would seat in an unscoped chat. */
function chatSeat(roster: RosterSeat[]): string | undefined {
  const seat = roster.find(
    (s) => (s as { chat_admission?: { unscoped?: { ok?: boolean } } }).chat_admission?.unscoped?.ok === true,
  );
  return seat === undefined ? undefined : String(seat.key);
}

export function seatParser(deps: SeatParserDeps): (text: string) => Promise<ParseOutcome> {
  const { adapter } = deps;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  return async (text) => {
    const seat = chatSeat(deps.roster());
    if (seat === undefined) {
      return { ok: false, code: 409, error: 'no seat can take a turn to read the order — sign a seat in from the System page' };
    }
    const projects = adapter.projectsSupported()
      ? (await adapter.projectList()).map((p) => ({ id: p.id, name: p.name }))
      : [];
    const chatId = `standing-order-parse-${randomUUID()}`;
    const cwd = mkdtempSync(join(tmpdir(), 'crew-order-parse-'));
    let off: () => void = () => undefined;
    try {
      const reply = new Promise<{ text: string; ok: boolean } | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        off = adapter.onEvent((e: CoreEvent) => {
          const ev = e as unknown as { type?: string; chat?: string; text?: string; ok?: boolean };
          if (ev.type === 'chatReply' && ev.chat === chatId) {
            clearTimeout(timer);
            resolve({ text: typeof ev.text === 'string' ? ev.text : '', ok: ev.ok === true });
          }
        });
      });
      const opened = await adapter.chatOpen(chatId, [seat], cwd);
      if (!opened.some((s) => s.ok)) {
        return { ok: false, code: 502, error: `the ${seat} seat could not open: ${opened[0]?.error ?? 'refused'}` };
      }
      await adapter.chatSend(chatId, parsePrompt(text, projects), [seat]);
      const answer = await reply;
      if (answer === null) return { ok: false, code: 502, error: `the ${seat} seat did not answer in ${timeoutMs / 1000} s` };
      // A failed turn is a failure, whatever its text holds — never a rule to confirm (codex on #686).
      if (!answer.ok) return { ok: false, code: 502, error: `the ${seat} seat's turn failed`, answer: answer.text };
      const rule = ruleFromAnswer(answer.text);
      if (rule === undefined) {
        return { ok: false, code: 422, error: 'the seat could not turn the words into a rule — try plainer words', answer: answer.text };
      }
      return { ok: true, rule, seat };
    } catch (err) {
      return { ok: false, code: 502, error: err instanceof Error ? err.message : String(err) };
    } finally {
      off();
      await adapter.chatClose(chatId).catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}
