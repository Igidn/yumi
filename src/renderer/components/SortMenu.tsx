import { useEffect, useRef, useState } from "react";
import { ArrowDownNarrowWide, ArrowUpNarrowWide, Check } from "lucide-react";
import { SORT_OPTIONS, type SortKey } from "../library/sort";
import { fitToViewport } from "../shared/fit-to-viewport";

export function SortMenu({
  sortKey,
  onSelect,
  onClose,
  anchorRef,
}: {
  sortKey: SortKey;
  onSelect: (key: SortKey) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Anchor the menu under the trigger button. Recompute on open and on
  // resize so it follows the trigger if the window changes.
  useEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      setPos(fitToViewport(r.right, r.bottom + 4, 180, 240));
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
    // Next tick so the click that opened the menu doesn't close it.
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
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-field";

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Sort by"
      className="fixed z-50 min-w-[180px] overflow-hidden rounded-[8px] border border-edge bg-shell py-1 shadow-shell"
      style={pos ?? { left: -9999, top: -9999 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {SORT_OPTIONS.map((opt) => {
        const active = sortKey.field === opt.field;
        return (
          <button
            key={opt.field}
            role="menuitemradio"
            aria-checked={active}
            className={item}
            onClick={() => {
              // Re-clicking the active field flips the direction.
              onSelect(
                active
                  ? {
                      field: opt.field,
                      dir: sortKey.dir === "asc" ? "desc" : "asc",
                    }
                  : { field: opt.field, dir: opt.defaultDir },
              );
            }}
          >
            <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-muted">
              {active ? <Check size={12} strokeWidth={2.25} /> : null}
            </span>
            <span className="flex-1">{opt.label}</span>
            {active ? (
              sortKey.dir === "asc" ? (
                <ArrowUpNarrowWide
                  size={14}
                  strokeWidth={1.75}
                  className="text-muted"
                />
              ) : (
                <ArrowDownNarrowWide
                  size={14}
                  strokeWidth={1.75}
                  className="text-muted"
                />
              )
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
