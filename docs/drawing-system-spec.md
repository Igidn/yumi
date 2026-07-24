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
