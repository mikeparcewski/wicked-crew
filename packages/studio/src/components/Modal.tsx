import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: Props): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the dialog on mount and restore the previous element on unmount.
  // Empty deps so `prev` is captured exactly once at mount time, regardless
  // of whether `onClose` is re-created on re-renders (avoids focus restoration
  // bug when parent does not memoize the callback).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      prev?.focus();
    };
  }, []);

  // Keyboard handler: Escape closes, Tab/Shift+Tab stays within the modal.
  // Separate effect from focus restoration so the cleanup order is predictable.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const el = dialogRef.current;
      if (!el) return;
      // Include only visible, non-disabled focusable descendants.
      const focusable = Array.from(
        el.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => !n.hasAttribute('disabled') && (n.offsetWidth > 0 || n.offsetHeight > 0));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        // Also handle Shift+Tab when focus is on the dialog container itself
        // (initial state immediately after mount before the user Tabs forward).
        if (document.activeElement === first || document.activeElement === el) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className="relative w-[90vw] h-[80vh] rounded-xl bg-white shadow-2xl flex flex-col focus:outline-none"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <h2 id="modal-title" className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
