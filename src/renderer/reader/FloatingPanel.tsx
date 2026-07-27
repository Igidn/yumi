import { useState, useCallback, useEffect, useRef } from "react";
import { GripHorizontal, Minus, X, Pen, Plus, Pencil, Trash2, Copy, Eraser } from "lucide-react";
import type { DrawingTab } from "../../shared/types";
import { DrawingSurface } from "./DrawingSurface";

interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
const HANDLE_SIZE = 6;
const CORNER_SIZE = 12;

const PANEL_STATE_KEY = "drawing:panel-state";
const ACTIVE_TAB_KEY = "drawing:active-tab";

const DEFAULT_RECT: PanelRect = { x: 100, y: 80, width: 340, height: 440 };

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

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

interface FloatingPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FloatingPanel({ isOpen, onClose }: FloatingPanelProps) {
  const [rect, setRect] = useState<PanelRect>(() => loadPanelState() ?? DEFAULT_RECT);
  const [minimized, setMinimized] = useState(false);
  const [tabs, setTabs] = useState<DrawingTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  // Bumped to force-remount the canvas after a local "clear canvas" (the
  // scene-updated broadcast skips the sending window).
  const [canvasNonce, setCanvasNonce] = useState(0);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    savePanelState(rect);
  }, [rect]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    (async () => {
      let loaded = await window.yumi.invoke("drawing:load-tabs");
      if (cancelled) return;

      // Auto-create first tab if none exist.
      if (loaded.length === 0) {
        const first = await window.yumi.invoke("drawing:create-tab", { label: "Canvas 1" });
        if (cancelled) return;
        loaded = [first];
      }

      setTabs(loaded);

      // Restore last active tab, or default to first.
      const saved = localStorage.getItem(ACTIVE_TAB_KEY);
      setActiveTabId(
        saved && loaded.some((t) => t.id === saved) ? saved : loaded[0].id
      );
    })();

    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (activeTabId) localStorage.setItem(ACTIVE_TAB_KEY, activeTabId);
  }, [activeTabId]);

  useEffect(() => {
    if (editingTabId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingTabId]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = () => setCtxMenu(null);
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [ctxMenu]);

  const handleCreateTab = useCallback(async () => {
    const idx = tabs.length + 1;
    const label = `Canvas ${idx}`;
    const tab = await window.yumi.invoke("drawing:create-tab", { label });
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, [tabs.length]);

  const handleRenameStart = useCallback((tab: DrawingTab) => {
    setEditingTabId(tab.id);
    setEditingLabel(tab.label);
    setCtxMenu(null);
  }, []);

  const handleRenameCommit = useCallback(async () => {
    const tabId = editingTabId;
    const label = editingLabel.trim();
    if (!tabId || !label) {
      setEditingTabId(null);
      return;
    }
    await window.yumi.invoke("drawing:rename-tab", { tabId, label });
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, label } : t))
    );
    setEditingTabId(null);
  }, [editingTabId, editingLabel]);

  const handleDeleteTab = useCallback(async (tabId: string) => {
    setCtxMenu(null);
    if (tabs.length <= 1) return; // keep at least one tab
    if (!window.confirm("Delete this canvas and all its drawings?")) return;

    await window.yumi.invoke("drawing:delete-tab", { tabId });
    const remaining = tabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    if (activeTabId === tabId) setActiveTabId(remaining[0].id);
  }, [tabs, activeTabId]);

  const handleDuplicateTab = useCallback(async (tabId: string) => {
    setCtxMenu(null);
    const src = tabs.find((t) => t.id === tabId);
    if (!src) return;

    const sceneData = await window.yumi.invoke("drawing:load-scene", { tabId });
    const newTab = await window.yumi.invoke("drawing:create-tab", {
      label: `${src.label} (copy)`,
    });
    if (sceneData) {
      await window.yumi.invoke("drawing:save-scene", {
        tabId: newTab.id,
        sceneData,
      });
    }
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [tabs]);

  const handleClearTab = useCallback(
    async (tabId: string) => {
      setCtxMenu(null);
      if (!window.confirm("Clear all drawings from this canvas?")) return;
      await window.yumi.invoke("drawing:clear-tab", { tabId });
      // The broadcast skips the sender, so remount the local canvas to show
      // the now-empty scene when the cleared tab is the visible one.
      if (tabId === activeTabId) setCanvasNonce((n) => n + 1);
    },
    [activeTabId]
  );

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
    <>
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

      {/* ---- tab strip ---- */}
      <div className="flex shrink-0 items-center border-b border-reader-edge bg-[#1a1a1a]">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto no-scrollbar">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isEditing = tab.id === editingTabId;

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                onDoubleClick={() => handleRenameStart(tab)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                }}
                className={`group relative flex h-[32px] shrink-0 cursor-pointer select-none items-center border-r border-reader-edge px-3 text-[12px] transition-colors ${
                  isActive
                    ? "bg-[#121212] text-reader"
                    : "text-reader-muted hover:bg-[#161616] hover:text-reader"
                }`}
              >
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    value={editingLabel}
                    onChange={(e) => setEditingLabel(e.target.value)}
                    onBlur={handleRenameCommit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameCommit();
                      if (e.key === "Escape") setEditingTabId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-[80px] rounded-[3px] bg-[#2a2a2a] px-1 py-0 text-[12px] text-reader outline-none"
                  />
                ) : (
                  <span className="max-w-[90px] truncate">{tab.label}</span>
                )}
              </div>
            );
          })}
        </div>

        <button
          onClick={handleCreateTab}
          className="flex h-[32px] w-[32px] shrink-0 items-center justify-center text-reader-muted transition-colors hover:bg-[#161616] hover:text-reader"
          aria-label="New canvas"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>

      {/* ---- canvas area ---- */}
      {activeTabId && (
        <DrawingSurface
          key={`${activeTabId}:${canvasNonce}`}
          tabId={activeTabId}
        />
      )}

      {/* ---- resize handles ---- */}
      {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as ResizeDir[]).map((dir) => (
        <ResizeHandle
          key={dir}
          dir={dir}
          onPointerDown={(e) => onResizeStart(dir, e)}
        />
      ))}
      </div>

      {/* ---- tab context menu (outside panel so position: fixed uses viewport) ---- */}
      {ctxMenu && (
        <TabContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          tabsCount={tabs.length}
          onRename={() => {
            const tab = tabs.find((t) => t.id === ctxMenu.tabId);
            if (tab) handleRenameStart(tab);
          }}
          onDelete={() => handleDeleteTab(ctxMenu.tabId)}
          onDuplicate={() => handleDuplicateTab(ctxMenu.tabId)}
          onClear={() => handleClearTab(ctxMenu.tabId)}
        />
      )}
    </>
  );
}

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

function TabContextMenu({
  x,
  y,
  tabsCount,
  onRename,
  onDelete,
  onDuplicate,
  onClear,
}: {
  x: number;
  y: number;
  tabsCount: number;
  onRename: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClear: () => void;
}) {
  const items = [
    { icon: Pencil, label: "Rename", action: onRename },
    { icon: Copy, label: "Duplicate", action: onDuplicate },
    { icon: Eraser, label: "Clear canvas", action: onClear },
    ...(tabsCount > 1
      ? [{ icon: Trash2, label: "Delete", action: onDelete, danger: true }]
      : []),
  ];

  // Adjust position so the menu fits within the viewport.
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 160),
    top: Math.min(y, window.innerHeight - items.length * 32 - 8),
    zIndex: 50,
  };

  return (
    <div
      style={style}
      className="min-w-[140px] overflow-hidden rounded-[6px] border border-reader-edge bg-[#1e1e1e] py-1 shadow-[0_4px_16px_rgba(0,0,0,0.5)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.action}
          className={`flex w-full items-center gap-2 px-3 py-[7px] text-[12px] transition-colors ${
            item.danger
              ? "text-red-400 hover:bg-red-400/10"
              : "text-reader-muted hover:bg-[#2a2a2a] hover:text-reader"
          }`}
        >
          <item.icon size={13} strokeWidth={1.75} />
          {item.label}
        </button>
      ))}
    </div>
  );
}
