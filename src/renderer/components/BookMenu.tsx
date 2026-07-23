import { useEffect } from "react";
import type { Book } from "../../shared/types";

export type MenuState = { book: Book; x: number; y: number };

export function BookMenu({
  menu,
  onClose,
  onDetails,
  onToggleFinished,
  onDelete,
}: {
  menu: MenuState;
  onClose: () => void;
  onDetails: () => void;
  onToggleFinished: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // next tick so the opening click doesn't instantly dismiss
    const t = setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  const finished = menu.book.progress >= 1;
  const item =
    "flex w-full px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-field disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent";

  return (
    <div
      role="menu"
      className="fixed z-50 min-w-[160px] overflow-hidden rounded-[8px] border border-edge bg-shell py-1 shadow-shell"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onToggleFinished();
          onClose();
        }}
      >
        {finished ? "Mark as still reading" : "Mark as finished"}
      </button>
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onDetails();
          onClose();
        }}
      >
        Details
      </button>
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          void window.yumi.invoke("books:reveal", { id: menu.book.id });
          onClose();
        }}
      >
        Reveal in folder
      </button>
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        Delete
      </button>
    </div>
  );
}
