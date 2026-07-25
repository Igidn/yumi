import { useRef, useEffect, useState, useCallback } from "react";
import type { SerializedStroke, DrawingStroke } from "../../shared/types";

// ── grid ──
const GRID_SPACING = 20;
const GRID_DOT_RADIUS = 1.5;
const GRID_DOT_COLOR = "rgba(255,255,255,0.10)";

// ── cache ──
const CACHE_PAD = 512; // px of extra canvas around strokes

interface ViewTransform {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

// ── helpers ──

function renderStroke(ctx: CanvasRenderingContext2D, stroke: SerializedStroke) {
  const { points, color, width } = stroke;
  if (points.length < 2) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Compute axis-aligned bounding box that contains every stroke. */
function strokesBounds(strokes: SerializedStroke[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function renderGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: ViewTransform,
) {
  ctx.clearRect(0, 0, w, h);

  const spacing = GRID_SPACING;
  const dotR = GRID_DOT_RADIUS;

  // World-space rect visible in the viewport.
  const left = -t.offsetX / t.zoom;
  const top = -t.offsetY / t.zoom;
  const right = left + w / t.zoom;
  const bottom = top + h / t.zoom;

  const startX = Math.floor(left / spacing) * spacing;
  const startY = Math.floor(top / spacing) * spacing;

  ctx.fillStyle = GRID_DOT_COLOR;
  for (let wx = startX; wx <= right; wx += spacing) {
    for (let wy = startY; wy <= bottom; wy += spacing) {
      const sx = wx * t.zoom + t.offsetX;
      const sy = wy * t.zoom + t.offsetY;
      ctx.beginPath();
      ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ── component ──

export function DrawingCanvas({
  tabId,
  activeTool,
  gridVisible,
}: {
  tabId: string;
  activeTool: string;
  gridVisible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const interactionCanvasRef = useRef<HTMLCanvasElement>(null);
  // Offscreen cache bitmap for completed strokes (Layer 2: not in DOM).
  const cacheRef = useRef<HTMLCanvasElement | null>(null);
  // World origin in cache-canvas pixel space.
  const cacheAnchorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [transform, setTransform] = useState<ViewTransform>({ offsetX: 0, offsetY: 0, zoom: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const [strokes, setStrokes] = useState<SerializedStroke[]>([]);
  const strokesRef = useRef<SerializedStroke[]>([]);
  strokesRef.current = strokes;

  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const containerSizeRef = useRef(containerSize);
  containerSizeRef.current = containerSize;

  const cacheDirtyRef = useRef(true);
  const bgDirtyRef = useRef(true);
  const rafPendingRef = useRef(false);

  // ── schedule a render frame (deduplicates via rAF) ──
  const scheduleRender = useCallback(() => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;
      const { w, h } = containerSizeRef.current;
      if (w === 0 || h === 0) return;

      if (cacheDirtyRef.current) {
        rebuildCache();
      }

      const bgCvs = bgCanvasRef.current;
      const intCvs = interactionCanvasRef.current;
      const cache = cacheRef.current;
      if (!bgCvs || !intCvs) return;

      const t = transformRef.current;

      // --- Layer 1: background grid ---
      if (bgDirtyRef.current) {
        const bgCtx = bgCvs.getContext("2d")!;
        bgCvs.width = w;
        bgCvs.height = h;
        if (gridVisible) {
          renderGrid(bgCtx, w, h, t);
        } else {
          bgCtx.clearRect(0, 0, w, h);
        }
        bgDirtyRef.current = false;
      }

      // --- Layer 3: interaction (cache blit + live strokes) ---
      const intCtx = intCvs.getContext("2d")!;
      if (intCvs.width !== w || intCvs.height !== h) {
        intCvs.width = w;
        intCvs.height = h;
      } else {
        intCtx.clearRect(0, 0, w, h);
      }

      if (cache) {
        const anchor = cacheAnchorRef.current;
        const viewX = -t.offsetX / t.zoom;
        const viewY = -t.offsetY / t.zoom;
        const viewW = w / t.zoom;
        const viewH = h / t.zoom;

        // Source rect in cache-canvas pixel space.
        const sx = viewX - anchor.x;
        const sy = viewY - anchor.y;

        intCtx.save();
        intCtx.scale(t.zoom, t.zoom);
        intCtx.translate(-viewX, -viewY);
        intCtx.drawImage(cache, sx, sy, viewW, viewH, viewX, viewY, viewW, viewH);
        intCtx.restore();
      }
    });
  }, [gridVisible]);

  // Keep scheduleRender ref current so the rAF callback always calls the latest.
  const scheduleRenderRef = useRef(scheduleRender);
  scheduleRenderRef.current = scheduleRender;

  // ── rebuild cache when strokes change ──
  const rebuildCache = () => {
    const { w, h } = containerSizeRef.current;
    if (w === 0 || h === 0) return;

    const all = strokesRef.current;
    const bounds = strokesBounds(all);
    const finite = isFinite(bounds.minX);
    const pad = CACHE_PAD;

    const cacheW = finite
      ? Math.max(bounds.maxX - bounds.minX + pad * 2, w)
      : w * 2;
    const cacheH = finite
      ? Math.max(bounds.maxY - bounds.minY + pad * 2, h)
      : h * 2;

    const anchorX = finite ? bounds.minX - pad : -cacheW / 2;
    const anchorY = finite ? bounds.minY - pad : -cacheH / 2;

    const offscreen = document.createElement("canvas");
    offscreen.width = Math.ceil(cacheW);
    offscreen.height = Math.ceil(cacheH);
    const ctx = offscreen.getContext("2d")!;

    for (const s of all) {
      ctx.save();
      ctx.translate(-anchorX, -anchorY);
      renderStroke(ctx, s);
      ctx.restore();
    }

    cacheRef.current = offscreen;
    cacheAnchorRef.current = { x: anchorX, y: anchorY };
    cacheDirtyRef.current = false;
  };

  // ── reload strokes when tab changes ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows: DrawingStroke[] = await window.yumi.invoke("drawing:load-strokes", { tabId });
      if (cancelled) return;
      const parsed = rows.map((r) => JSON.parse(r.jsonData) as SerializedStroke);
      strokesRef.current = parsed;
      setStrokes(parsed);
      cacheDirtyRef.current = true;
      scheduleRenderRef.current();
    })();
    return () => { cancelled = true; };
  }, [tabId]);

  // ── listen for external strokes ──
  useEffect(() => {
    const unsubs = [
      window.yumi.on("drawing:external-stroke", (_data: unknown) => {
        const data = _data as { tabId: string; stroke: DrawingStroke };
        if (data.tabId !== tabId) return;
        const parsed = JSON.parse(data.stroke.jsonData) as SerializedStroke;
        const next = strokesRef.current.some((s) => s.uuid === parsed.uuid)
          ? strokesRef.current
          : [...strokesRef.current, parsed];
        strokesRef.current = next;
        setStrokes(next);
        cacheDirtyRef.current = true;
        scheduleRenderRef.current();
      }),
      window.yumi.on("drawing:external-strokes-removed", (_data: unknown) => {
        const data = _data as { tabId: string; strokeIds: string[] };
        if (data.tabId !== tabId) return;
        const ids = new Set(data.strokeIds);
        const next = strokesRef.current.filter((s) => !ids.has(s.uuid));
        strokesRef.current = next;
        setStrokes(next);
        cacheDirtyRef.current = true;
        scheduleRenderRef.current();
      }),
      window.yumi.on("drawing:external-tab-cleared", (_data: unknown) => {
        const data = _data as { tabId: string };
        if (data.tabId !== tabId) return;
        strokesRef.current = [];
        setStrokes([]);
        cacheDirtyRef.current = true;
        scheduleRenderRef.current();
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [tabId]);

  // ── grid toggle ──
  useEffect(() => {
    bgDirtyRef.current = true;
    scheduleRenderRef.current();
  }, [gridVisible]);

  // ── resize observer ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const w = Math.round(width);
        const h = Math.round(height);
        if (w > 0 && h > 0) {
          containerSizeRef.current = { w, h };
          setContainerSize({ w, h });
          bgDirtyRef.current = true;
          scheduleRenderRef.current();
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── pan with hand tool (and future pen tool) ──
  const panState = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (activeTool !== "hand") return;
      e.currentTarget.setPointerCapture(e.pointerId);
      panState.current = {
        sx: e.clientX,
        sy: e.clientY,
        ox: transformRef.current.offsetX,
        oy: transformRef.current.offsetY,
      };
    },
    [activeTool],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!panState.current) return;
    const dx = e.clientX - panState.current.sx;
    const dy = e.clientY - panState.current.sy;
    const next: ViewTransform = {
      ...transformRef.current,
      offsetX: panState.current.ox + dx,
      offsetY: panState.current.oy + dy,
    };
    transformRef.current = next;
    setTransform(next);
    bgDirtyRef.current = true;
    scheduleRenderRef.current();
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    panState.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // ── zoom with scroll wheel ──
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.10 : 1 / 1.10;
    const t = transformRef.current;
    const newZoom = Math.min(4, Math.max(0.25, t.zoom * factor));

    // Zoom toward cursor position.
    const rect = containerRef.current?.getBoundingClientRect();
    let next: ViewTransform;
    if (rect) {
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const wx = (cx - t.offsetX) / t.zoom;
      const wy = (cy - t.offsetY) / t.zoom;
      next = {
        zoom: newZoom,
        offsetX: cx - wx * newZoom,
        offsetY: cy - wy * newZoom,
      };
    } else {
      next = { ...t, zoom: newZoom };
    }

    transformRef.current = next;
    setTransform(next);
    bgDirtyRef.current = true;
    scheduleRenderRef.current();
  }, []);

  // ── cursor ──
  const cursor =
    activeTool === "hand" ? "grab"
    : activeTool === "pen" ? "crosshair"
    : "default";

  const { w, h } = containerSize;

  return (
    <div
      ref={containerRef}
      className="canvas-stack"
      style={{
        flex: 1,
        position: "relative",
        overflow: "hidden",
        cursor,
      }}
      onWheel={onWheel}
    >
      {/* Layer 1: background (dot grid). Redrawn on resize/pan/zoom only. */}
      <canvas
        ref={bgCanvasRef}
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
        width={w}
        height={h}
      />

      {/* Layer 3: interaction. Cache blit + live strokes, cleared each frame. */}
      <canvas
        ref={interactionCanvasRef}
        style={{ position: "absolute", top: 0, left: 0 }}
        width={w}
        height={h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}
