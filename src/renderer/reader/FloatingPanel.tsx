import { useState, useCallback, useEffect } from "react";
import { GripHorizontal, Minus, X, Pen } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
const HANDLE_SIZE = 6;
const CORNER_SIZE = 12;

const PANEL_STATE_KEY = "drawing:panel-state";

const DEFAULT_RECT: PanelRect = { x: 100, y: 80, width: 340, height: 440 };

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function clamp(val: number, min: number, max: number) {
  return Math.min(max, Math.max(min, val));
}

function loadPanelState(): PanelRect | null {
  try {
    const raw = localStorage.getItem(PANEL_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PanelRect;
  } catch {
    return null;
  }
}

function savePanelState(rect: PanelRect) {
  try {
    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(rect));
  } catch {
    /* quota exceeded */
  }
}

function cursorForDir(dir: ResizeDir): string {
  switch (dir) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "nw":
    case "se":
      return "nwse-resize";
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface FloatingPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FloatingPanel({ isOpen, onClose }: FloatingPanelProps) {
  const [rect, setRect] = useState<PanelRect>(() => loadPanelState() ?? DEFAULT_RECT);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    savePanelState(rect);
  }, [rect]);

  // ---- drag (window-level listeners, no pointer capture) ------------

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const px = rect.x;
      const py = rect.y;

      const onMove = (ev: PointerEvent) => {
        setRect((prev) => ({
          ...prev,
          x: px + (ev.clientX - startX),
          y: py + (ev.clientY - startY),
        }));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [rect]
  );

  // ---- resize (window-level listeners, no pointer capture) ---------

  const onResizeStart = useCallback(
    (dir: ResizeDir, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const px = rect.x;
      const py = rect.y;
      const pw = rect.width;
      const ph = rect.height;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        setRect(() => {
          let x = px;
          let y = py;
          let w = pw;
          let h = ph;

          if (dir.includes("e")) w = clamp(pw + dx, MIN_WIDTH, 9999);
          if (dir.includes("w")) {
            const newW = clamp(pw - dx, MIN_WIDTH, 9999);
            x = px + pw - newW;
            w = newW;
          }
          if (dir.includes("s")) h = clamp(ph + dy, MIN_HEIGHT, 9999);
          if (dir.includes("n")) {
            const newH = clamp(ph - dy, MIN_HEIGHT, 9999);
            y = py + ph - newH;
            h = newH;
          }

          return { x, y, width: w, height: h };
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [rect]
  );

  // ---- render --------------------------------------------------------

  if (!isOpen) return null;

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 right-4 z-[25] flex h-[38px] w-[38px] items-center justify-center rounded-full border border-reader-edge bg-reader-chrome/95 shadow-shell backdrop-blur-md transition-transform hover:scale-105"
        aria-label="Restore drawing panel"
      >
        <Pen size={17} strokeWidth={1.75} className="text-reader-muted" />
      </button>
    );
  }

  return (
    <div
      className="fixed z-[25] flex flex-col overflow-hidden rounded-[10px] border border-reader-edge bg-reader-chrome/95 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-md"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
    >
      {/* ---- title bar (drag handle) ---- */}
      <div
        className="flex h-[38px] shrink-0 cursor-grab select-none items-center gap-2 border-b border-reader-edge px-2 active:cursor-grabbing"
        onPointerDown={onDragStart}
      >
        <GripHorizontal size={14} strokeWidth={1.75} className="text-reader-muted" />
        <span className="flex-1 text-[12px] font-medium text-reader-muted">
          Drawings
        </span>

        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMinimized(true)}
          className="rounded-[5px] p-1 text-reader-muted transition-colors hover:bg-reader-edge/50 hover:text-reader"
          aria-label="Minimize drawing panel"
        >
          <Minus size={14} strokeWidth={2} />
        </button>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onClose()}
          className="rounded-[5px] p-1 text-reader-muted transition-colors hover:bg-reader-edge/50 hover:text-reader"
          aria-label="Close drawing panel"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {/* ---- canvas area ---- */}
      <div className="flex-1" style={{ backgroundColor: "#121212" }} />

      {/* ---- resize handles ---- */}
      {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as ResizeDir[]).map((dir) => (
        <ResizeHandle
          key={dir}
          dir={dir}
          onPointerDown={(e) => onResizeStart(dir, e)}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ResizeHandle                                                      */
/* ------------------------------------------------------------------ */

function ResizeHandle({
  dir,
  onPointerDown,
}: {
  dir: ResizeDir;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const isCorner = dir.length === 2;
  const size = isCorner ? CORNER_SIZE : HANDLE_SIZE;

  const style: React.CSSProperties = {
    position: "absolute",
    cursor: cursorForDir(dir),
  };

  if (isCorner) {
    style.width = size;
    style.height = size;
  }

  if (dir === "n") {
    style.top = 0;
    style.left = CORNER_SIZE;
    style.right = CORNER_SIZE;
    style.height = HANDLE_SIZE;
  } else if (dir === "s") {
    style.bottom = 0;
    style.left = CORNER_SIZE;
    style.right = CORNER_SIZE;
    style.height = HANDLE_SIZE;
  } else if (dir === "e") {
    style.right = 0;
    style.top = CORNER_SIZE;
    style.bottom = CORNER_SIZE;
    style.width = HANDLE_SIZE;
  } else if (dir === "w") {
    style.left = 0;
    style.top = CORNER_SIZE;
    style.bottom = CORNER_SIZE;
    style.width = HANDLE_SIZE;
  }

  if (dir === "ne") {
    style.top = -4;
    style.right = -4;
  } else if (dir === "nw") {
    style.top = -4;
    style.left = -4;
  } else if (dir === "se") {
    style.bottom = -4;
    style.right = -4;
  } else if (dir === "sw") {
    style.bottom = -4;
    style.left = -4;
  }

  return <div style={style} onPointerDown={onPointerDown} />;
}
