import {
  Copy,
  Eraser,
  Minus,
  Pen,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
const CORNER_SIZE = 16;
// Keep the panel below the reader's auto-hiding header (h-[52px] in
// ReaderView); parked under it, the panel's drag strip gets covered and
// can't be recovered.
const MIN_Y = 25;

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
  const [rect, setRect] = useState<PanelRect>(() => {
    const saved = loadPanelState();
    return saved
      ? { ...saved, y: Math.max(saved.y, MIN_Y) }
      : DEFAULT_RECT;
  });
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
        const first = await window.yumi.invoke("drawing:create-tab", {
          label: "Canvas 1",
        });
        if (cancelled) return;
        loaded = [first];
      }

      setTabs(loaded);

      // Restore last active tab, or default to first.
      const saved = localStorage.getItem(ACTIVE_TAB_KEY);
      setActiveTabId(
        saved && loaded.some((t) => t.id === saved) ? saved : loaded[0].id,
      );
    })();

    return () => {
      cancelled = true;
    };
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
    try {
      const maxNum = tabs.reduce((max, t) => {
        const m = t.label.match(/^Canvas (\d+)$/);
        return m ? Math.max(max, parseInt(m[1], 10)) : max;
      }, 0);
      const label = `Canvas ${maxNum + 1}`;
      const tab = await window.yumi.invoke("drawing:create-tab", { label });
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    } catch (err) {
      console.error(err);
    }
  }, [tabs]);

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
    try {
      await window.yumi.invoke("drawing:rename-tab", { tabId, label });
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, label } : t)),
      );
    } catch (err) {
      console.error(err);
    }
    setEditingTabId(null);
  }, [editingTabId, editingLabel]);

  const handleDeleteTab = useCallback(
    async (tabId: string) => {
      setCtxMenu(null);
      if (tabs.length <= 1) return; // keep at least one tab
      if (!window.confirm("Delete this canvas and all its drawings?")) return;

      try {
        await window.yumi.invoke("drawing:delete-tab", { tabId });
        const remaining = tabs.filter((t) => t.id !== tabId);
        setTabs(remaining);
        if (activeTabId === tabId) setActiveTabId(remaining[0].id);
      } catch (err) {
        console.error(err);
      }
    },
    [tabs, activeTabId],
  );

  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      setCtxMenu(null);
      const src = tabs.find((t) => t.id === tabId);
      if (!src) return;

      try {
        const sceneData = await window.yumi.invoke("drawing:load-scene", {
          tabId,
        });
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
      } catch (err) {
        console.error(err);
      }
    },
    [tabs],
  );

  const handleClearTab = useCallback(
    async (tabId: string) => {
      setCtxMenu(null);
      if (!window.confirm("Clear all drawings from this canvas?")) return;
      try {
        await window.yumi.invoke("drawing:clear-tab", { tabId });
        // The broadcast skips the sender, so remount the local canvas to show
        // the now-empty scene when the cleared tab is the visible one.
        if (tabId === activeTabId) setCanvasNonce((n) => n + 1);
      } catch (err) {
        console.error(err);
      }
    },
    [activeTabId],
  );

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const px = rect.x;
      const py = rect.y;

      const onMove = (ev: PointerEvent) => {
        setRect({
          x: px + (ev.clientX - startX),
          y: Math.max(py + (ev.clientY - startY), MIN_Y),
          width: rect.width,
          height: rect.height,
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [rect],
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
          y = Math.max(py + ph - newH, MIN_Y);
          h = py + ph - y; // shrink if the snap to MIN_Y clipped the size
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
    [rect],
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
        className="fixed z-[25] flex flex-col overflow-hidden rounded-[12px] border border-reader-edge shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          backgroundColor: "#121212",
        }}
      >
        {/* ---- header: identity chip, pill tabs, window controls.
               One row (the whole empty area is the drag region) so the
               canvas keeps as much vertical space as possible. ---- */}
        <div
          className="flex h-10 shrink-0 cursor-grab select-none items-center gap-1 border-b border-white/[0.06] bg-[#171512] pl-2.5 pr-1.5 active:cursor-grabbing"
          onPointerDown={onDragStart}
        >
          <div
            className="mr-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--reader-accent) 18%, transparent)",
            }}
            title="Drawings"
          >
            <Pen
              size={12}
              strokeWidth={2}
              style={{ color: "var(--reader-accent)" }}
            />
          </div>

          {/* pill tabs (scrollable); empty strip space stays draggable */}
          <div
            role="tablist"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar"
          >
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const isEditing = tab.id === editingTabId;

              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={isActive}
                  title={isEditing ? undefined : tab.label}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setActiveTabId(tab.id)}
                  onDoubleClick={() => handleRenameStart(tab)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                  }}
                  className={`group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] pl-2.5 text-[12px] transition-colors ${
                    isActive
                      ? "bg-white/[0.08] pr-1.5 font-medium text-stone-100"
                      : "pr-2.5 text-stone-500 hover:bg-white/[0.04] hover:text-stone-300"
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
                      onDoubleClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="h-[20px] w-[88px] rounded-[4px] bg-black/40 px-1.5 text-[12px] text-stone-100 outline-none"
                      style={{ boxShadow: "0 0 0 1px var(--reader-accent)" }}
                    />
                  ) : (
                    <>
                      <span className="max-w-[110px] truncate">
                        {tab.label}
                      </span>
                      {isActive &&
                        (tabs.length > 1 ? (
                          /* Accent dot that morphs into a close button on hover */
                          <span className="relative flex h-[16px] w-[16px] items-center justify-center">
                            <span
                              className="h-[5px] w-[5px] rounded-full transition-opacity group-hover:opacity-0"
                              style={{
                                backgroundColor: "var(--reader-accent)",
                              }}
                            />
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDeleteTab(tab.id);
                              }}
                              onPointerDown={(e) => e.stopPropagation()}
                              className="absolute inset-0 flex items-center justify-center rounded-[4px] opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100"
                              aria-label={`Delete ${tab.label}`}
                              title="Delete canvas"
                            >
                              <X size={11} strokeWidth={2.25} />
                            </button>
                          </span>
                        ) : (
                          <span
                            className="mx-[5px] h-[5px] w-[5px] rounded-full"
                            style={{ backgroundColor: "var(--reader-accent)" }}
                          />
                        ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={handleCreateTab}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-stone-500 transition-colors hover:bg-white/[0.06] hover:text-stone-200"
            aria-label="New canvas"
            title="New canvas"
          >
            <Plus size={14} strokeWidth={2} />
          </button>

          <div className="mx-1 h-4 w-px shrink-0 bg-white/[0.08]" />

          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMinimized(true)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-stone-500 transition-colors hover:bg-white/[0.06] hover:text-stone-200"
            aria-label="Minimize drawing panel"
            title="Minimize"
          >
            <Minus size={14} strokeWidth={2} />
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onClose()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-stone-500 transition-colors hover:bg-red-500/15 hover:text-red-400"
            aria-label="Close drawing panel"
            title="Close"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {/* ---- canvas area ---- */}
        {activeTabId && (
          <DrawingSurface
            key={`${activeTabId}:${canvasNonce}`}
            tabId={activeTabId}
            position={rect}
          />
        )}

        {/* ---- resize handles ---- */}
        {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as ResizeDir[]).map(
          (dir) => (
            <ResizeHandle
              key={dir}
              dir={dir}
              onPointerDown={(e) => onResizeStart(dir, e)}
            />
          ),
        )}
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
    zIndex: 30,
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
    style.top = 0;
    style.right = 0;
  } else if (dir === "nw") {
    style.top = 0;
    style.left = 0;
  } else if (dir === "se") {
    style.bottom = 0;
    style.right = 0;
  } else if (dir === "sw") {
    style.bottom = 0;
    style.left = 0;
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
    left: Math.min(x, window.innerWidth - 168),
    top: Math.min(y, window.innerHeight - items.length * 30 - 12),
    zIndex: 50,
  };

  return (
    <div
      style={style}
      className="min-w-[152px] overflow-hidden rounded-[9px] border border-white/[0.08] bg-[#211e1a]/95 p-1 shadow-[0_10px_32px_rgba(0,0,0,0.55)] backdrop-blur-md"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.action}
          className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-[6px] text-[12px] transition-colors ${
            item.danger
              ? "text-red-400/90 hover:bg-red-500/10 hover:text-red-400"
              : "text-stone-400 hover:bg-white/[0.06] hover:text-stone-100"
          }`}
        >
          <item.icon size={13} strokeWidth={1.75} />
          {item.label}
        </button>
      ))}
    </div>
  );
}
