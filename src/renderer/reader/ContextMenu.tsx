import { Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import type { TtsSelection } from "../../shared/types";

interface ContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  selection: TtsSelection | null;
  onSpeak: (sel: TtsSelection) => void;
  onDismiss: () => void;
}

export function ContextMenu({
  visible,
  x,
  y,
  selection,
  onSpeak,
  onDismiss,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on click-away or Escape.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    // Use a microtask so the right-click event that opened the menu doesn't
    // immediately close it via the click-away listener.
    const id = setTimeout(() => {
      window.addEventListener("keydown", onKey);
      window.addEventListener("click", onClick);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [visible, onDismiss]);

  const handleSpeak = useCallback(() => {
    if (selection) onSpeak(selection);
    onDismiss();
  }, [selection, onSpeak, onDismiss]);

  if (!visible || !selection) return null;

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[120px] rounded-lg bg-reader-chrome py-1 shadow-lg border border-reader-edge"
      style={{ left: x, top: y }}
    >
      <button
        onClick={handleSpeak}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-reader hover:bg-reader-edge/40 transition-colors"
      >
        <Volume2 size={15} strokeWidth={1.75} />
        Speak
      </button>
    </div>
  );
}

/** Extract TTS selection info from the current DOM selection. */
export function getTtsSelection(): TtsSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  let blockEl: HTMLElement | null = null;
  let node: Node | null = range.startContainer;

  while (node) {
    if (node instanceof HTMLElement && node.hasAttribute("data-b")) {
      blockEl = node;
      break;
    }
    node = node.parentElement;
  }

  if (!blockEl) return null;

  const blockIndex = parseInt(blockEl.getAttribute("data-b")!, 10);

  // Compute character offset within the block's textContent.
  const preRange = document.createRange();
  preRange.setStart(blockEl, 0);
  preRange.setEnd(range.startContainer, range.startOffset);
  const charOffset = preRange.toString().length;

  return { blockIndex, charOffset };
}
