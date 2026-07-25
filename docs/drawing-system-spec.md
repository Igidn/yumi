# Drawing System — Full Specification

## Overview

A floating, tabbed drawing panel that overlays the reader. Not inline annotations tied to text — a freeform notepad the user can position anywhere, persist across books and sessions, and use for handwritten notes, sketches, or marginalia.

## Pipeline / Data Flow

```
User draws → live stroke (vector) on interaction canvas
Stroke ends → rasterize to offscreen bitmap cache
                   ↓
             store stroke data (points, tool, color, width)
             in database alongside bitmap thumbnail
                   ↓
Pan/zoom → blit cached bitmap (instant)
Select/tap → load vector data, render live, allow edit
```

On re-open: load all strokes → composite into cache bitmap in one pass → ready to render.

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

### Drawing Tools

Toolbar sits at the top of the panel (above the tab strip or inside each tab).

| Tool | Behavior |
|------|----------|
| **Pen** | Freehand drawing. Variable width controlled by slider (1–20px). Anti-aliased. |
| **Eraser** | Deletes entire strokes the eraser path intersects (vector hit-test). Not a pixel eraser. Has larger effective radius than pen. |
| **Color picker** | Preset palette (black, red, blue, green, yellow, white) plus custom hex input. Per-stroke color. |
| **Selection** | Lasso or rectangle select. Selected strokes can be moved, resized (scale handles), or deleted. |
| **Undo** | Reverts last stroke (Ctrl+Z / Cmd+Z). Unlimited undo stack per tab. |
| **Redo** | Re-applies undone stroke (Ctrl+Shift+Z). |
| **Clear canvas** | Removes all strokes from current tab (with confirmation). |
| **Hand/Pan** | Grab-and-drag to pan the canvas when zoomed in. |

### Canvas Behavior

- Infinite canvas within the panel viewport — pan to scroll, zoom with scroll wheel or pinch.
- Grid background (subtle dot grid, optional, toggleable).
- Zoom level displayed as percentage (25%–400%), reset button to 100%.
- Canvas dimensions: infinite in all directions. Strokes can extend beyond the visible viewport.
- No per-page anchoring. The canvas is independent of reader pagination.

### Rendering Architecture

Three-layer canvas stack:

1. **Background canvas** — grid dots, static. Redrawn on resize only.
2. **Cache canvas** — completed strokes rasterized as a bitmap. On pan/zoom, `drawImage` blits this; no curve math.
3. **Interaction canvas** — the live stroke being drawn, plus any selected/editing strokes. Cleared and redrawn each frame during active drawing.

**When a stroke finishes:**
- Rasterize it onto the cache canvas.
- Add its vector data (points, tool, color, width, bounding box) to the stroke list.
- Clear the interaction canvas.

**When a stroke is selected:**
- Remove it from the cache canvas (re-render cache without it).
- Draw it live on the interaction canvas with selection handles.
- On deselect: rasterize back to cache.

**When panning/zooming:**
- Scale and re-blit the cache canvas. Instant — no per-stroke computation.

### Persistence & Multi-Window Sync

- Strokes stored per tab, not per book.
- One SQLite table: `drawings (id, tab_id, stroke_index, json_data, created_at, updated_at)`.
- `json_data` stores the serialized stroke: `{ uuid, tool, color, width, points: [{x,y}...], bbox: {x,y,w,h} }`.
- On panel open: load all strokes for active tab → composite cache in one pass.
- Auto-save after each stroke completes (debounced 500ms).
- Thumbnail generation: downscaled bitmap of the first ~20 strokes for tab previews.

**Multi-window sync:** When the same tab is open in two reader windows (two books with the same drawing panel), changes propagate in real time:

1. User completes a stroke → renderer A adds it locally, sends `drawing:stroke-added` to main process.
2. Main process saves to SQLite, broadcasts to all windows with that tab loaded.
3. Renderer B receives the stroke (filtering out its own by uuid) → adds it to state → rasterizes onto cache canvas.
4. Erase/undo/clear follow the same broadcast pattern.

The renderer only needs one additional method: `addExternalStroke(stroke)` — it does the same thing as completing a local stroke but skips the IPC send.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `B` | Pen tool |
| `E` | Eraser tool |
| `V` | Selection tool |
| `H` | Hand/pan tool |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Delete` | Delete selected strokes |
| `Ctrl++` / `Ctrl+-` | Zoom in/out |
| `Ctrl+0` | Reset zoom to 100% |

### Panel Toggle

- Button in reader chrome (pen icon) toggles the drawing panel.
- Panel remembers its last position, size, and active tab.
- If closed and re-opened, restores previous state.

## Terminology

- **Stroke** — a single continuous line drawn between pointer-down and pointer-up. Has tool, color, width, and an array of points.
- **Tab** — an independent canvas inside the drawing panel. Replaces the concept of "page" to avoid confusion with reader pagination.
- **Cache canvas** — the offscreen bitmap containing all finished strokes. Blitted on pan/zoom for performance.
- **Panel** — the floating window containing tabs, toolbar, and canvas. One panel per session.

---

## Implementation Steps

### Step 1: Database + IPC wiring
- Create `drawings.db` with WAL mode in the app's data directory
- Table: `tabs (id, label, created_at)` + `strokes (id, tab_id, stroke_index, json_data, created_at, updated_at)`
- IPC handlers: `drawing:load-tabs`, `drawing:load-strokes`, `drawing:stroke-added`, `drawing:stroke-erased`, `drawing:undo`, `drawing:create-tab`, `drawing:rename-tab`, `drawing:delete-tab`, `drawing:clear-tab`
- Broadcast `drawing:external-stroke` to all windows when a stroke is saved
- Each stroke gets a `uuid` for dedup across windows

### Step 2: Floating panel shell
- `FloatingPanel` component: absolute-positioned div, draggable by title bar, resizable from edges/corners
- Minimum size 200x150, stored position/size remembered across sessions
- Minimize button (collapses to a floating pill), close button
- Toggle button (pen icon) in reader header chrome opens/closes the panel
- Panel lives above reader content, below TOC/search/appearance panels

### Step 3: Tab system
- Horizontal tab strip inside the panel with "Canvas 1", "Canvas 2", etc.
- "+" button creates new tab (confirmed in DB)
- Double-click tab to rename
- Right-click: rename, delete, duplicate, clear canvas
- Active tab persisted, restored on re-open
- Delete/clear filtered through confirmation dialog

### Step 4: Canvas rendering (three-layer)
- **Background canvas**: static dot grid pattern, redrawn on resize only
- **Cache canvas**: offscreen — completed strokes rasterized here via `drawImage`. On pan/zoom, blitted at scale+offset
- **Interaction canvas**: live stroke (current draw) + selected/editing strokes, cleared each frame
- When a stroke finishes: rasterize to cache → save to DB → broadcast → clear interaction
- When receiving external stroke: add to state → rasterize to cache

### Step 5: Drawing tools
- **Pen**: freehand stroke generation using `perfect-freehand` for smoothing. Variable width (1-20px slider)
- **Eraser**: vector hit-test against stroke bounding boxes, deletes matching strokes
- **Color picker**: preset swatches (black, red, blue, green, yellow, white) + custom hex input
- **Toolbar**: horizontal strip above the tab bar

### Step 6: Canvas interactions
- **Pan**: grab-drag canvas when hand tool active (scrollbars hidden)
- **Zoom**: scroll wheel or pinch, 25%-400%, percentage indicator, Ctrl+0 to reset
- **Infinite canvas**: no bounds, strokes can be placed anywhere
- **Grid toggle**: checkbox or hotkey to show/hide dot grid

### Step 7: Selection + manipulation
- **Selection tool**: lasso-freehand (reuse `perfect-freehand`) or rectangle select
- Selected strokes render live on interaction canvas with bounding-box handles
- **Move**: drag selected strokes
- **Delete**: Delete key removes selected strokes (broadcast to other windows)
- Scale/rotate handles on bounding box

### Step 8: Undo/Redo
- Per-tab undo stack (array of stroke UUIDs)
- Undo: remove last stroke from cache (re-render cache without it), broadcast removal
- Redo: re-add stroke to cache, broadcast addition
- Ctrl+Z / Ctrl+Shift+Z keyboard handling (scoped to when panel is focused)

### Step 9: Polish
- Panel state (position, size, active tab, minimized) persisted in app settings, not drawings.db
- Smooth open/close animation (scale-fade)
- Empty state: "No drawings yet. Start sketching!" with pen illustration
- Keyboard shortcuts table visible on first open (dismissable)
- Tool cursor changes (crosshair for pen, circle for eraser, default for hand)
- Touch/pencil support: pressure sensitivity via PointerEvent.pressure if available
