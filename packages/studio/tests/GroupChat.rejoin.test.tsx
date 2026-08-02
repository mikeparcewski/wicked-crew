import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupChat } from '../src/components/GroupChat.js';

/**
 * FINDING-027 — the per-mount chat leak.
 *
 * A chat is a pool of warm CLI sessions costing ~520 MB apiece, deliberately outliving the page so
 * an operator can navigate away and come back. The component minted a fresh `crypto.randomUUID()`
 * on every effect fire, so every remount abandoned one — nothing on either side ever closed it, and
 * with no list endpoint nobody could find it again. Measured across one campaign: 19 seats warmed,
 * 2 chats ever closed, 4.10 GB reclaimed by hand.
 *
 * These tests pin the CONSEQUENCE (a second mount does not open a second chat), not the mechanism —
 * the exact remount trigger in production was never pinned down, and a fix keyed to one trigger
 * would leak on the next one.
 */

const openChat = vi.fn();
const getChat = vi.fn();
const closeChat = vi.fn();
const getRoster = vi.fn();

vi.mock('../src/api/client.js', () => ({
  api: {
    openChat: (...a: unknown[]) => openChat(...a),
    getChat: (...a: unknown[]) => getChat(...a),
    closeChat: (...a: unknown[]) => closeChat(...a),
    getRoster: (...a: unknown[]) => getRoster(...a),
    sendChatMessage: vi.fn(),
  },
  wsBase: () => 'ws://localhost',
}));

// The component subscribes to the daemon's event stream for seat/delta frames. None of these cases
// depend on a live socket, and opening one would make the suite time-dependent.
vi.mock('../src/hooks/useEventStream.js', () => ({ useEventStream: () => undefined }));

beforeEach(() => {
  openChat.mockReset();
  getChat.mockReset();
  closeChat.mockReset();
  getRoster.mockReset();
  getRoster.mockResolvedValue({ roster: [{ key: 'claude' }] });
  openChat.mockResolvedValue({ chatId: 'x', seats: [{ cliKey: 'claude', ok: true }] });
  closeChat.mockResolvedValue({ ok: true });
  sessionStorage.clear();
});

describe('GroupChat — chat reuse (FINDING-027)', () => {
  it('a remount rejoins the live chat instead of opening a second one', async () => {
    // Mount 1: nothing stored, so it mints and opens.
    const first = render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(1));
    const openedId = (openChat.mock.calls[0]?.[0] as { chatId: string }).chatId;
    expect(openedId).toBeTruthy();

    // The daemon still holds it.
    getChat.mockResolvedValue({ chatId: openedId, seats: ['claude'] });
    first.unmount();

    // Mount 2: the leak. Before the fix this called openChat a second time and the first chat's
    // seats stayed warm forever, referenced by nobody.
    render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(getChat).toHaveBeenCalledWith(openedId));
    await waitFor(() => expect(screen.getByTitle('ready')).toHaveTextContent('claude'));
    expect(openChat, 'a rejoin must not open a second chat').toHaveBeenCalledTimes(1);
  });

  it('a stored id the daemon has already reclaimed is discarded, not rejoined', async () => {
    // The daemon reaps idle chats and enforces a pool cap, so a stored id is a claim and not a
    // fact. `chat_seats` answers an empty list for an unknown chat rather than erroring — which is
    // exactly the shape that would silently produce a dead-looking chat if trusted.
    sessionStorage.setItem('wicked.chat.r1', 'reclaimed-id');
    getChat.mockResolvedValue({ chatId: 'reclaimed-id', seats: [] });

    render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(1));
    const openedId = (openChat.mock.calls[0]?.[0] as { chatId: string }).chatId;
    expect(openedId).not.toBe('reclaimed-id');
    expect(sessionStorage.getItem('wicked.chat.r1')).toBe(openedId);
  });

  it('each repo keeps its own chat, so a repo switch does not abandon one', async () => {
    // A prop change on ONE mounted component, not two renders: `repoId` is an effect dep, so a
    // switch re-runs the effect in place. Two separate mounts would exercise a different path and
    // would not catch state that fails to reset across the switch.
    const { rerender } = render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(1));
    const idA = sessionStorage.getItem('wicked.chat.r1');

    // A different repo is a different conversation — it opens its own rather than reusing r1's.
    rerender(<GroupChat repoId="r2" onBack={() => undefined} />);
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(2));
    const idB = sessionStorage.getItem('wicked.chat.r2');

    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idB).not.toBe(idA);
    // r1's id survives the switch — coming back rejoins it rather than leaking it.
    expect(sessionStorage.getItem('wicked.chat.r1')).toBe(idA);
  });

  it('a repo switch leaves no trace of the previous repo on screen', async () => {
    // The effect is keyed on repoId, so a switch re-runs it in place — but per-chat React state
    // does not reset on its own. A transcript carried across the switch is attributed to the wrong
    // repo's chat, which is a wrong answer rendered confidently.
    const user = userEvent.setup();
    const { rerender } = render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(1));

    await user.type(screen.getByRole('textbox'), 'a message about repo one');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('a message about repo one')).toBeTruthy());

    rerender(<GroupChat repoId="r2" onBack={() => undefined} />);
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText('a message about repo one'),
      "r1's transcript must not appear under r2's chat",
    ).toBeNull();
  });

  it('a daemon we cannot reach is not the same as a chat that is gone', async () => {
    // The sharp edge of the whole fix. `chat_seats` answers an EMPTY LIST for a chat the daemon no
    // longer holds — that is the reclaimed signal. A thrown error means we do not know, and minting
    // on "do not know" orphans a chat that may still be warm AND discards the only id that could
    // have reached it: the exact leak, reintroduced by a transient 5xx.
    sessionStorage.setItem('wicked.chat.r1', 'maybe-alive');
    getChat.mockRejectedValue(new Error('502 Bad Gateway'));

    render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(getChat).toHaveBeenCalledWith('maybe-alive'));
    await waitFor(() => expect(screen.getByText(/502 Bad Gateway/)).toBeTruthy());

    expect(openChat, 'an unreachable daemon must not mint a second chat').not.toHaveBeenCalled();
    expect(sessionStorage.getItem('wicked.chat.r1')).toBe('maybe-alive');
  });

  it('a rejoin shows the seats the chat actually has, not the ones the roster lists', async () => {
    // Optimistic `warming` chips stand in for an open that is in flight. After a rejoin there is no
    // open and no seat events are coming, so a roster seat absent from the rejoined chat would sit
    // at `warming` forever with nothing left to correct it — a chip that lies indefinitely.
    //
    // The roster is resolved LAST, deliberately. Both requests are in flight at once and the bug
    // only bites when the roster lands after the rejoin has already written the seat map; letting
    // the mocks race would make this test pass or fail on microtask ordering rather than on
    // behaviour.
    let releaseRoster = (): void => undefined;
    getRoster.mockReturnValue(
      new Promise((resolve) => {
        releaseRoster = () => resolve({ roster: [{ key: 'claude' }, { key: 'codex' }] });
      }),
    );
    sessionStorage.setItem('wicked.chat.r1', 'live-id');
    getChat.mockResolvedValue({ chatId: 'live-id', seats: ['claude'] });

    render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTitle('ready')).toHaveTextContent('claude'));
    releaseRoster();
    await waitFor(() => expect(getRoster).toHaveBeenCalled());

    expect(openChat).not.toHaveBeenCalled();
    expect(screen.queryByTitle('warming'), 'no seat may be left warming after a rejoin').toBeNull();
  });

  it('End chat forgets the id, so the next mount starts clean instead of rejoining a closed chat', async () => {
    const user = userEvent.setup();
    render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('wicked.chat.r1')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'End chat' }));
    await waitFor(() => expect(closeChat).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('wicked.chat.r1')).toBeNull();
  });

  it('a failed close still forgets the id — an ended chat must never be rejoined', async () => {
    // Teardown is best-effort, but the id must go regardless: the daemon's idle reaper will collect
    // the seats either way, whereas rejoining a chat the operator ended is a visible wrong answer.
    const user = userEvent.setup();
    closeChat.mockRejectedValue(new Error('daemon unreachable'));
    render(<GroupChat repoId="r1" onBack={() => undefined} />);
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'End chat' }));
    await waitFor(() => expect(closeChat).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('wicked.chat.r1')).toBeNull();
  });
});
