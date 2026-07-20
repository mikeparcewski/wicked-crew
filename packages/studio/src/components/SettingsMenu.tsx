import { useEffect, useRef } from 'react';

interface Props {
  onNavigate: (path: string) => void;
  onClose: () => void;
}

const ITEMS: { label: string; path: string }[] = [
  { label: 'Workflows', path: '/workflows' },
  { label: 'Policies', path: '/policies' },
  { label: 'Rules', path: '/rules' },
];

export function SettingsMenu({ onNavigate, onClose }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside.
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  // Focus the first menu item when the menu opens so keyboard navigation
  // begins inside the menu immediately (WAI-ARIA menu pattern).
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, []);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 w-44 rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl py-1 z-50"
      role="menu"
      // Escape is handled here (not on document) so it does not propagate to
      // parent overlay components (e.g. a Modal) that have their own Escape handler.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {ITEMS.map((item) => (
        <button
          key={item.path}
          type="button"
          role="menuitem"
          onClick={() => { onNavigate(item.path); onClose(); }}
          className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-white focus-visible:bg-zinc-700 focus-visible:text-white focus-visible:outline-none transition-colors"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
