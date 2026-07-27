# Drawing System — Full Specification

## Overview

A floating, tabbed drawing panel that overlays the reader. Not inline annotations tied to text — a freeform notepad the user can position anywhere, persist across books and sessions, and use for handwritten notes, sketches, or marginalia.

Uses the [`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw) React component for the drawing surface. The package provides an infinite canvas, tools (pen, eraser, selection, shapes, text), undo/redo, zoom/pan, grid, and keyboard shortcuts out of the box.

## Pipeline / Data Flow

```
User draws → Excalidraw component (all rendering internal)
              ↓
onChange fires → debounce 500ms
              ↓
        save { elements, appState } scene blob to SQLite
              ↓
        broadcast to other windows (same tab)
              ↓
        external window: load scene blob → set Excalidraw initialData
```

On re-open: load scene blob for active tab → pass as `initialData` to `<Excalidraw>` → ready.

## Features

### Panel Window

The drawing panel is a floating, resizable, movable window within the reader viewport. It exists independently of the current chapter or book — it stays open as the user navigates.

- Draggable by title bar or edge grip.
- Resizable from any corner or edge, with minimum dimensions (200x150px).
- Minimizable to a small floating pill/button that restores the panel.
- Closeable. 
- Always on top of reader content (z-index above WebKit, below system panels like TOC/search).

### Tab System

Inside the panel, a horizontal tab strip allows multiple independent canvases.

- "New tab" button (+ icon) creates a blank canvas.
- Tab labels default to "Canvas 1", "Canvas 2", etc. — user can rename by double-clicking the tab.
- Right-click tab: rename, delete, duplicate, clear canvas.
- Tabs persist across sessions. Opening a different book does not close or change the panel.
- Active tab is remembered per-session (re-opens to last-used tab).

### Drawing Tools (all provided by Excalidraw)

Excalidraw's built-in toolbar covers all required tools. The component ships with:

| Tool | Notes |
|------|-------|
| **Pen / freehand** | Anti-aliased freehand with configurable stroke width, smoothing, and pressure support. |
| **Eraser** | Vector eraser — deletes elements the eraser path intersects. |
| **Shapes** | Rectangle, ellipse, diamond, arrow, line. Bonus — not in original spec. |
| **Text** | Text labels with font size control. Bonus — not in original spec. |
| **Color picker** | Preset palette + custom hex input. Per-element stroke and fill colors. |
| **Selection** | Rectangle select. Move, resize, rotate, duplicate, delete selected elements. |
| **Undo/Redo** | Built-in, unlimited stack. Ctrl+Z / Ctrl+Shift+Z. |
| **Hand/Pan** | Grab-to-pan (hold Space or select hand tool). |
| **Zoom** | Scroll wheel / pinch, 10%–3000% range, zoom controls in toolbar. |

We configure `UIOptions` to hide Excalidraw's top bar (its own header/library buttons) and keep only the toolbar relevant to a notepad use case.

### Canvas Behavior (all provided by Excalidraw)

- Infinite canvas — pan and zoom freely.
- Dot grid background (toggleable via `appState.gridModeEnabled`).
- Zoom controls and percentage indicator in the built-in footer.
- Canvas is independent of reader pagination.

### Rendering Architecture

Handled entirely by Excalidraw's internal canvas. No custom canvas stack needed. The component renders to a single `<canvas>` and optimizes repaints internally.

### Persistence & Multi-Window Sync

- Scene stored per tab, not per book.
- One SQLite table: `tabs (id, label, created_at, scene_data TEXT)`.
- `scene_data` stores the full Excalidraw scene as JSON: `{ elements: ExcalidrawElement[], appState: { scrollX, scrollY, zoom, ... } }`.
- On panel open: load scene blob for active tab → pass as `initialData`.
- Auto-save on every `onChange` from Excalidraw (debounced 500ms).

**Multi-window sync:** When the same tab is open in two reader windows, changes propagate:

1. User draws → Excalidraw fires `onChange` → renderer A debounce-saves scene blob to main process via `drawing:save-scene`.
2. Main process writes to SQLite, broadcasts `drawing:scene-updated` with the new scene blob to all other windows.
3. Renderer B receives the scene blob → calls `updateScene({ elements, appState })` on the Excalidraw component ref to apply changes without remounting.

Since the scene blob is small (vector data, not bitmaps), full-scene sync is fine.

### Keyboard Shortcuts (all built into Excalidraw)

| Shortcut | Action |
|----------|--------|
| `1` / `2` / `3` etc. | Switch tools quickly |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Delete` / `Backspace` | Delete selected elements |
| `Ctrl++` / `Ctrl+-` | Zoom in/out |
| `Ctrl+0` | Reset zoom |
| `Space` (hold) | Temporarily switch to hand/pan tool |

See [Excalidraw keyboard shortcuts docs](https://github.com/excalidraw/excalidraw#keyboard-shortcuts) for the full list.

### Panel Toggle

- Button in reader chrome (pen icon located on the left-side of appearance icon, use lucide icon) toggles the drawing panel.
- Panel remembers its last position, size, and active tab.
- If closed and re-opened, restores previous state.

## Terminology

- **Element** — any object on the Excalidraw canvas (freehand stroke, shape, text, arrow, image). Excalidraw's internal data model.
- **Scene** — the full serializable state of an Excalidraw canvas: `{ elements: ExcalidrawElement[], appState: ... }`. Stored as a JSON blob.
- **Tab** — an independent canvas inside the drawing panel. Each tab has its own scene blob.
- **Panel** — the floating window containing tabs and the Excalidraw component. One panel per session.

---

## Implementation Steps

### Step 1: Simplify database + IPC

**Schema** — replace `strokes` table with a `scene_data TEXT` column on `tabs`:

```sql
CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  scene_data TEXT  -- JSON: { elements, appState }
);
```

**IPC channels** (reduced from 12 to 7):
- `drawing:load-tabs` → returns all tabs (labels, ids; scene_data excluded for list view)
- `drawing:load-scene` → returns scene_data for one tab
- `drawing:save-scene` → upserts scene_data + broadcasts `drawing:scene-updated`
- `drawing:create-tab` → inserts new tab with empty scene_data
- `drawing:rename-tab`
- `drawing:delete-tab`
- `drawing:clear-tab` → sets scene_data to null + broadcasts

**Multi-window broadcast** — single event: `drawing:scene-updated` with `{ tabId, sceneData }`. No per-stroke dedup needed; the scene blob is authoritative.

### Step 2: Floating panel shell (unchanged from current impl)

Already implemented in `FloatingPanel.tsx`:
- Draggable by title bar, resizable from edges/corners, min 200×150
- Minimize (to pill), close, toggle button in reader header
- Position/size persisted via `localStorage`

### Step 3: Tab system (unchanged from current impl)

Already implemented:
- Horizontal tab strip, "+" button, double-click rename, right-click context menu
- Active tab persisted via `localStorage`

### Step 4: Integrate Excalidraw component

Replace `<DrawingCanvas>` with `<Excalidraw>` in `FloatingPanel.tsx`:

```tsx
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types/types";

// Inside FloatingPanel, per active tab:
const excalidrawRef = useRef<ExcalidrawImperativeAPI>(null);
const [sceneData, setSceneData] = useState<SceneBlob | null>(null);

// Load scene on tab switch
useEffect(() => {
  window.yumi.invoke("drawing:load-scene", { tabId: activeTabId })
    .then(data => setSceneData(data ? JSON.parse(data) : null));
}, [activeTabId]);

// Debounced save on change
const saveScene = useCallback(debounce(async (elements, appState) => {
  await window.yumi.invoke("drawing:save-scene", {
    tabId: activeTabId,
    sceneData: JSON.stringify({ elements, appState }),
  });
}, 500), [activeTabId]);

// Listen for external scene updates
useEffect(() => {
  const unsub = window.yumi.on("drawing:scene-updated", (data) => {
    if (data.tabId !== activeTabId) return;
    const scene = JSON.parse(data.sceneData);
    excalidrawRef.current?.updateScene({ elements: scene.elements, appState: scene.appState });
  });
  return unsub;
}, [activeTabId]);

return (
  <Excalidraw
    key={activeTabId}
    ref={excalidrawRef}
    initialData={sceneData ?? { elements: [], appState: { viewBackgroundColor: "transparent" } }}
    onChange={(data) => saveScene(data.elements, data.appState)}
    UIOptions={{
      canvasActions: {
        export: false,
        loadScene: false,
        saveAsImage: false,
      },
    }}
  />
);
```

**Config notes:**
- `key={activeTabId}` forces remount on tab switch (trashes Excalidraw's internal undo stack per tab — correct behavior).
- `UIOptions` hides Excalidraw's top-left menu and library button. Keep the toolbar.
- `viewBackgroundColor: "transparent"` so the panel background shows through.
- Excalidraw's own toolbar renders inside the component — no separate toolbar component needed.

### Step 5: Excalidraw theme

Match Excalidraw's theme to the reader theme. The reader uses a dark background; configure Excalidraw with:

```tsx
<Excalidraw
  theme="dark"
  initialData={{
    appState: {
      theme: "dark",
      viewBackgroundColor: "transparent",
      currentItemStrokeColor: "#ffffff",
    },
  }}
/>
```

### Step 6: Polish

- Panel state (position, size, active tab, minimized) — already persisted via `localStorage`.
- Smooth open/close animation — CSS transition on the panel container.
- Empty state — Excalidraw's canvas is inherently empty by default; no custom empty state needed.
- Excalidraw handles all tool cursors, touch/pen pressure, and keyboard shortcuts automatically.
- Tab duplicate: load source scene, `create-tab` + `save-scene` with the same data.

### Step 7: Remove custom canvas code

Delete or archive:
- `src/renderer/reader/DrawingCanvas.tsx` — replaced by `<Excalidraw>`
- `src/main/drawings-db.ts` — replace `strokes` table logic with scene blob CRUD
- `src/main/drawings-ipc.ts` — simplify to 7 scene-based IPC handlers
- `src/shared/types.ts` — remove `SerializedStroke`, `DrawingStroke`; add `SceneBlob` type
- `perfect-freehand` dependency — remove from `package.json` (not needed; Excalidraw bundles its own smoothing)

