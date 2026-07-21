import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, terminalWsUrl } from '../api/client.js';

interface Props {
  /** The terminalId from a workerSessionStarted event — connects to this existing PTY. */
  terminalId: string;
  /** CLI key label shown in the header bar. */
  cliKey: string;
  /** Called when the close (×) button is clicked. */
  onClose: () => void;
}

/**
 * Attaches an xterm.js viewer to an already-running agent PTY session.
 *
 * Unlike Terminal, this component does NOT create a new PTY — it connects
 * directly to the existing websocket for `terminalId`. On unmount it closes
 * the socket but does NOT call POST /terminals/:id/close (the engine owns the
 * lifecycle; closing it would kill the agent's CLI session).
 *
 * A RemoteObserver flag is sent so the daemon can track observer count without
 * forwarding keystrokes to the PTY (write-only from the agent's perspective).
 * For now keystrokes ARE forwarded — the operator can send input this way too.
 */
export function AgentTerminal({ terminalId, cliKey, onClose }: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let socket: WebSocket | undefined;

    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#ffda19', cursorAccent: '#0d1117' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }

    // Forward keystrokes to the PTY (operator can interact with the agent session).
    const dataSub = term.onData((chunk: string) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(chunk);
    });

    const ws = new WebSocket(terminalWsUrl(terminalIdRef.current));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') term.write(ev.data);
      else term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => {
      if (!disposed) term.write('\r\n\x1b[31m[terminal connection error]\x1b[0m\r\n');
    };
    ws.onclose = () => {
      if (!disposed) term.write('\r\n\x1b[90m[agent session ended]\x1b[0m\r\n');
    };
    socket = ws;

    const observe =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            try {
              fit.fit();
            } catch { /* not laid out */ }
            void api.resizeTerminal(terminalIdRef.current, term.cols, term.rows).catch(() => {});
          })
        : undefined;
    observe?.observe(host);

    return () => {
      disposed = true;
      observe?.disconnect();
      dataSub.dispose();
      try {
        socket?.close();
      } catch {
        /* already closing */
      }
      // Do NOT close the terminal — the engine owns the PTY lifecycle.
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div
      className="flex flex-col rounded-xl overflow-hidden"
      style={{ background: '#0d1117', border: '1px solid rgba(230,237,243,0.08)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 shrink-0"
        style={{ background: '#161c26', borderBottom: '1px solid rgba(230,237,243,0.06)' }}
      >
        <span className="text-[11px] font-mono font-semibold" style={{ color: 'rgba(230,237,243,0.5)' }}>
          {cliKey}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${cliKey} terminal`}
          className="text-[13px] leading-none opacity-50 hover:opacity-100 transition-opacity"
          style={{ background: 'transparent', border: 'none', color: '#e6edf3', cursor: 'pointer' }}
        >
          ×
        </button>
      </div>
      <div
        ref={hostRef}
        className="h-56 w-full overflow-hidden p-1"
      />
    </div>
  );
}
