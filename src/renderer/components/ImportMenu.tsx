import { FileUp, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { fitToViewport } from "../shared/fit-to-viewport";

/**
 * Dropdown under the toolbar Import button: two import sources — files
 * (dialog) and webnovel (freewebnovel.com URL prompt).
 */
export function ImportMenu({
  anchorRef,
  onImport,
  onWebnovel,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onImport: () => void;
  onWebnovel: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      setPos(fitToViewport(r.right, r.bottom + 4, 180, 120));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = setTimeout(() => {
      window.addEventListener("pointerdown", onPointer);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  const item =
    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-ink transition-colors hover:bg-field";

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Import options"
      className="fixed z-50 min-w-[180px] overflow-hidden rounded-[8px] border border-edge bg-shell py-1 shadow-shell"
      style={pos ?? { left: -9999, top: -9999 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onImport();
          onClose();
        }}
      >
        <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-muted">
          <FileUp size={14} strokeWidth={1.75} />
        </span>
        <span className="flex-1">Import files…</span>
      </button>
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onWebnovel();
          onClose();
        }}
      >
        <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-muted">
          <Globe size={14} strokeWidth={1.75} />
        </span>
        <span className="flex-1">Webnovel…</span>
      </button>
    </div>
  );
}
