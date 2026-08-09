import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { ContentBlock, ReaderChapter } from "../../shared/types";

/** Column geometry of the current viewport, recomputed on resize/typography. */
interface Geometry {
  /** Width of the multicol box: one or two columns plus the gap. */
  contentWidth: number;
  contentHeight: number;
  colWidth: number;
  colGap: number;
  /** Column width + column gap — the x-distance between column starts. */
  stride: number;
  /** Columns shown per spread: 2 for a book spread, 1 on narrow windows. */
  perSpread: number;
  /** Total spreads in the chapter. */
  spreads: number;
  /** Total columns (= "pages") in the chapter. */
  totalCols: number;
  /** Left/right whitespace around the centered content; page-turn zones. */
  margin: number;
}

export interface PageJump {
  /** Index into chapter.blocks to bring into view. */
  blockIndex: number;
  /** Changes on every request so re-jumping to the same block re-fires. */
  nonce: number;
}

export interface Reposition {
  /** 0–1 fraction inside the chapter to move to. */
  fraction: number;
  nonce: number;
}

export interface SpreadInfo {
  spread: number;
  spreads: number;
  perSpread: number;
  totalCols: number;
  /** 0–1 position inside the chapter. */
  fraction: number;
  /** Layout dims — enough to remeasure other chapters for book-wide page #s. */
  contentWidth: number;
  contentHeight: number;
  colWidth: number;
  colGap: number;
  /** First block index visible on the current spread, or null if unknown. */
  firstVisibleBlockIndex: number | null;
}

/** Offscreen CSS-column count for one chapter under a known layout. */
export function countChapterCols(
  chapter: ReaderChapter,
  layout: Pick<
    SpreadInfo,
    "contentWidth" | "contentHeight" | "colWidth" | "colGap"
  >,
  fontSize: number,
  lineHeight: number,
): number {
  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none";
  const content = document.createElement("div");
  content.className = "reader-content book-css";
  content.lang = "en";
  Object.assign(content.style, {
    width: `${layout.contentWidth}px`,
    height: `${layout.contentHeight}px`,
    columnWidth: `${layout.colWidth}px`,
    columnGap: `${layout.colGap}px`,
    columnFill: "auto",
    fontSize: `${fontSize}px`,
    lineHeight: String(lineHeight),
  });

  const spacer = document.createElement("div");
  spacer.style.height = "48px";
  content.appendChild(spacer);

  chapter.blocks.forEach((block, i) => {
    if (block.type === "image" && block.src) {
      const img = document.createElement("img");
      img.className = "reader-image";
      img.src = `yumi://asset/${block.src}`;
      img.style.width = `${layout.colWidth}px`;
      img.style.height = "auto";
      // Set natural dimensions so the browser reserves the correct aspect
      // ratio before the image loads — prevents column-count undercount.
      if (block.imgWidth && block.imgHeight) {
        img.width = block.imgWidth;
        img.height = block.imgHeight;
      } else {
        // ponytail: unknown dimensions — use a conservative placeholder so
        // column counting isn't wildly off.
        const ph = document.createElement("div");
        ph.style.height = `${layout.colWidth * 0.75}px`;
        content.appendChild(ph);
      }
      content.appendChild(img);
      return;
    }
    if (block.type === "heading") {
      const level = Math.min(6, Math.max(1, block.level ?? 1));
      const el = document.createElement(`h${level}`);
      el.className = blockClasses(block, i, chapter.blocks);
      el.style.cssText = block.style ?? "";
      if (block.html) el.innerHTML = block.html;
      else el.textContent = block.text;
      content.appendChild(el);
      return;
    }
    const p = document.createElement("p");
    p.className = blockClasses(block, i, chapter.blocks);
    p.style.cssText = block.style ?? "";
    if (block.html) p.innerHTML = block.html;
    else p.textContent = block.text;
    content.appendChild(p);
  });

  host.appendChild(content);
  document.body.appendChild(host);
  const stride = layout.colWidth + layout.colGap;
  const totalCols = Math.max(
    1,
    Math.round((content.scrollWidth + layout.colGap) / stride),
  );
  host.remove();
  return totalCols;
}

// Layout defaults mirrored from Readest (foliate paginator + DEFAULT_BOOK_LAYOUT):
// maxInlineSize 720, maxColumnCount 2, gapPercent 5, compact side margins 16.
const MAX_INLINE_SIZE = 720;
const MAX_COLUMN_COUNT = 2;
const GAP_PERCENT = 0.05;
const MARGIN_X = 16;
const CONTENT_V_INSET = 20; // top + bottom breathing room inside the viewport

function sameGeometry(a: Geometry | null, b: Geometry): Geometry {
  return a &&
    a.contentWidth === b.contentWidth &&
    a.contentHeight === b.contentHeight &&
    a.colWidth === b.colWidth &&
    a.colGap === b.colGap &&
    a.stride === b.stride &&
    a.perSpread === b.perSpread &&
    a.spreads === b.spreads &&
    a.totalCols === b.totalCols &&
    a.margin === b.margin
    ? a
    : b;
}

function headingClass(level: number, isFirst: boolean): string {
  const spacing = isFirst ? "mb-[1em]" : "mt-[1.15em] mb-[1em]";
  const size =
    level <= 1
      ? "text-[1.5em]"
      : level === 2
        ? "text-[1.25em]"
        : level === 3
          ? "text-[1.1em]"
          : "text-[1em]";
  return `${spacing} ${size} text-center font-bold leading-snug text-reader-accent`;
}

/** Class list for a heading/paragraph block — single source of truth for the
 *  measure pass and the live render, so column counts can't drift. */
function blockClasses(
  block: ContentBlock,
  i: number,
  blocks: ContentBlock[],
): string {
  const base =
    block.type === "heading"
      ? headingClass(Math.min(6, Math.max(1, block.level ?? 1)), i === 0)
      : i > 0 && blocks[i - 1].type === "paragraph"
        ? "reader-indent"
        : "";
  return `${base} ${block.className ?? ""}`.trim();
}

/**
 * Paginates a chapter into a two-page spread using CSS multi-column layout:
 * the content is a fixed-height multicol box whose columns overflow to the
 * right, and page turns are translateX steps of two columns. scrollWidth
 * reveals the total column count — the same technique foliate.js uses.
 */
export function PagedChapter({
  chapter,
  fontSize,
  lineHeight,
  /** Where to land when this chapter is first measured (0–1). */
  initialFraction,
  jump,
  reposition,
  onSpreadChange,
  onOverflow,
  onLinkNavigate,
  fragmentTarget,
  highlightBlockIndex,
  onTtsSpreadChange,
  onContextMenu,
}: {
  chapter: ReaderChapter;
  fontSize: number;
  lineHeight: number;
  initialFraction: number;
  jump: PageJump | null;
  reposition: Reposition | null;
  onSpreadChange: (info: SpreadInfo) => void;
  /** User paged past the first (-1) or last (+1) spread of the chapter. */
  onOverflow: (dir: -1 | 1) => void;
  /** User clicked an internal hyperlink with a resolved chapter target. */
  onLinkNavigate?: (chapterIndex: number, fragment: string | null) => void;
  /** Fragment ID + nonce to scroll to after geometry is measured (nonce forces re-fire). */
  fragmentTarget?: { fragment: string | null; nonce: number };
  /** Block index currently spoken by TTS — gets the `reader-tts-speaking` class. */
  highlightBlockIndex?: number | null;
  /** Spread the TTS highlight currently sits on (null until first highlight). */
  onTtsSpreadChange?: (spread: number) => void;
  /** Right-click on reader content. */
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<Geometry | null>(null);
  const [spread, setSpread] = useState(0);
  // Off until the user pages — avoids animating the post-measure landing spread
  // (e.g. chapter overflow back onto the previous chapter's last page).
  const [animate, setAnimate] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Position bookkeeping across geometry changes; reseeded on chapter
  // switch, kept up to date as the user pages.
  const fractionRef = useRef(initialFraction);
  const lastJumpNonce = useRef(0);
  const lastRepositionNonce = useRef(0);
  const lastFragmentNonce = useRef(0);

  // Chapter switches remount via key={chapter.id} in ReaderView.

  // Track the spread of the last TTS highlight so auto-turn only fires
  // when the reader was actually on the TTS page.
  const prevHighlightSpreadRef = useRef<number | null>(null);
  // Debounce auto-turn so transient highlight glitches (unreliable
  // onboundary charIndex on some platforms) don't trigger false turns.
  const autoTurnTimerRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const availW = viewport.clientWidth;
    const availH = viewport.clientHeight;
    if (availW === 0 || availH === 0) return;

    // Column count from host width (same formula as foliate/readest).
    const perSpread = Math.min(
      MAX_COLUMN_COUNT,
      Math.max(1, Math.ceil(Math.floor(availW) / Math.floor(MAX_INLINE_SIZE))),
    );
    // Keep at least MARGIN_X on each side so text never kisses the window edge.
    const innerW = Math.max(0, availW - MARGIN_X * 2);
    // gap = a/(1-a) * size keeps outer padding and column gap visually even.
    const colGap =
      perSpread > 1
        ? Math.round((-GAP_PERCENT / (GAP_PERCENT - 1)) * innerW)
        : 0;
    const colWidth = Math.floor(
      Math.min(
        (innerW - colGap * (perSpread - 1)) / perSpread,
        MAX_INLINE_SIZE,
      ),
    );
    const contentWidth = colWidth * perSpread + colGap * (perSpread - 1);
    const contentHeight = availH - CONTENT_V_INSET * 2;

    // Apply before reading scrollWidth; React writes the same values back
    // from `geom` on the next render, so ownership stays declarative.
    content.style.width = `${contentWidth}px`;
    content.style.height = `${contentHeight}px`;
    content.style.columnWidth = `${colWidth}px`;
    content.style.columnGap = `${colGap}px`;

    const stride = colWidth + colGap;
    const totalCols = Math.max(
      1,
      Math.round((content.scrollWidth + colGap) / stride),
    );
    const spreads = Math.max(1, Math.ceil(totalCols / perSpread));

    setGeom((prev) =>
      sameGeometry(prev, {
        contentWidth,
        contentHeight,
        colWidth,
        colGap,
        stride,
        perSpread,
        spreads,
        totalCols,
        margin: Math.max(0, (availW - contentWidth) / 2),
      }),
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const ro = new ResizeObserver(measure);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [measure, chapter.id, fontSize, lineHeight]);

  // After each re-measure: restore position — the resume fraction on the
  // first measure of a chapter, the live fraction on resize/typography
  // changes (fractionRef is reseeded on chapter switch, updated on paging).
  useLayoutEffect(() => {
    if (!geom) return;
    const target = Math.round(fractionRef.current * (geom.spreads - 1));
    setSpread(Math.min(Math.max(0, target), geom.spreads - 1));
  }, [geom]);

  // Report position + keep the fraction for future geometry changes.
  useEffect(() => {
    if (!geom) return;
    const fraction = geom.spreads <= 1 ? 1 : spread / (geom.spreads - 1);
    fractionRef.current = fraction;

    // Find the first visible block on the current spread.
    let firstVisibleBlockIndex: number | null = null;
    const content = contentRef.current;
    if (content) {
      const clipEl = content.parentElement;
      if (clipEl) {
        const cr = clipEl.getBoundingClientRect();
        for (const el of content.querySelectorAll<HTMLElement>("[data-b]")) {
          const r = el.getBoundingClientRect();
          if (
            r.bottom > cr.top &&
            r.top < cr.bottom &&
            r.right > cr.left &&
            r.left < cr.right
          ) {
            firstVisibleBlockIndex = parseInt(el.getAttribute("data-b")!, 10);
            break;
          }
        }
      }
    }

    onSpreadChange({
      spread,
      spreads: geom.spreads,
      perSpread: geom.perSpread,
      totalCols: geom.totalCols,
      fraction,
      contentWidth: geom.contentWidth,
      contentHeight: geom.contentHeight,
      colWidth: geom.colWidth,
      colGap: geom.colGap,
      firstVisibleBlockIndex,
    });
  }, [spread, geom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Same-chapter reposition (e.g. clicking the current chapter in the TOC).
  useEffect(() => {
    if (!reposition || !geom) return;
    if (reposition.nonce === lastRepositionNonce.current) return;
    lastRepositionNonce.current = reposition.nonce;
    fractionRef.current = reposition.fraction;
    const target = Math.round(reposition.fraction * (geom.spreads - 1));
    setSpread(Math.min(Math.max(0, target), geom.spreads - 1));
  }, [reposition, geom]);

  // Search-driven jump: locate the block element, derive its spread from its
  // column x-offset, then flash it so the eye lands on the right line.
  useEffect(() => {
    if (!jump || !geom) return;
    if (jump.nonce === lastJumpNonce.current) return;
    lastJumpNonce.current = jump.nonce;
    const content = contentRef.current;
    if (!content) return;
    const el = content.querySelector<HTMLElement>(
      `[data-b="${jump.blockIndex}"]`,
    );
    if (!el) return;
    const target = Math.floor(el.offsetLeft / (geom.stride * geom.perSpread));
    setSpread(Math.min(Math.max(0, target), geom.spreads - 1));
    el.classList.add("reader-flash");
    const timer = setTimeout(() => el.classList.remove("reader-flash"), 10000);
    return () => clearTimeout(timer);
  }, [jump, geom]);

  // Auto-turn: when TTS highlight moves to a block on a different spread,
  // turn the page — but only if the reader was already on the previous TTS spread.
  // Debounced (250ms) so transient highlight glitches (e.g. onboundary charIndex
  // reporting sentence-relative offsets on some platforms) don't trigger false turns.
  useEffect(() => {
    if (highlightBlockIndex == null || !geom) return;
    const content = contentRef.current;
    if (!content) return;
    const el = content.querySelector<HTMLElement>(
      `[data-b="${highlightBlockIndex}"]`,
    );
    if (!el) return;
    const contentRect = content.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const xOffset = elRect.left - contentRect.left;
    const targetSpread = Math.floor(xOffset / (geom.stride * geom.perSpread));
    onTtsSpreadChange?.(targetSpread);

    const prevSpread = prevHighlightSpreadRef.current;
    prevHighlightSpreadRef.current = targetSpread;

    if (targetSpread === spread || spread !== prevSpread) {
      // No turn needed, or reader manually paged away — clear any pending timer.
      if (autoTurnTimerRef.current !== null) {
        window.clearTimeout(autoTurnTimerRef.current);
        autoTurnTimerRef.current = null;
      }
      return;
    }

    // Debounce: only turn after the highlight has been on the target spread
    // for 250ms without interruption. A glitch that reverts within the window
    // is cancelled by the next effect run.
    if (autoTurnTimerRef.current !== null) {
      window.clearTimeout(autoTurnTimerRef.current);
    }
    autoTurnTimerRef.current = window.setTimeout(() => {
      autoTurnTimerRef.current = null;
      setAnimate(true);
      setSpread(Math.min(Math.max(0, targetSpread), geom.spreads - 1));
    }, 250);

    return () => {
      if (autoTurnTimerRef.current !== null) {
        window.clearTimeout(autoTurnTimerRef.current);
        autoTurnTimerRef.current = null;
      }
    };
  }, [highlightBlockIndex, geom, spread, onTtsSpreadChange]);

  // Fragment-based scroll: find the element with the matching id and scroll to its spread.
  useEffect(() => {
    if (!geom || !fragmentTarget?.fragment) return;
    if (fragmentTarget.nonce === lastFragmentNonce.current) return;
    lastFragmentNonce.current = fragmentTarget.nonce;
    const content = contentRef.current;
    if (!content) return;
    const el = content.querySelector<HTMLElement>(
      `[id="${CSS.escape(fragmentTarget.fragment)}"]`,
    );
    if (!el) return;
    // Use bounding rect relative to the content container — offsetLeft is
    // relative to offsetParent, which is wrong for inline targets inside <p>.
    const contentRect = content.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const xOffset = elRect.left - contentRect.left;
    const target = Math.floor(xOffset / (geom.stride * geom.perSpread));
    setSpread(Math.min(Math.max(0, target), geom.spreads - 1));
    el.classList.add("reader-flash");
    const timer = setTimeout(() => el.classList.remove("reader-flash"), 10000);
    return () => clearTimeout(timer);
  }, [geom, fragmentTarget]);

  const goNext = useCallback(() => {
    if (!geom) return;
    setAnimate(true);
    setSpread((s) => {
      if (s < geom.spreads - 1) return s + 1;
      onOverflow(1);
      return s;
    });
  }, [geom, onOverflow]);

  const goPrev = useCallback(() => {
    if (!geom) return;
    setAnimate(true);
    setSpread((s) => {
      if (s > 0) return s - 1;
      onOverflow(-1);
      return s;
    });
  }, [geom, onOverflow]);

  // Global Escape for lightbox
  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxSrc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxSrc]);

  // Page-turn keys live here (they need the spread state); ReaderView keeps
  // chapter-level and panel shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
          e.preventDefault();
          goNext();
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          goPrev();
          break;
        case " ":
          e.preventDefault();
          if (e.shiftKey) goPrev();
          else goNext();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev]);

  // Intercept hyperlink clicks on <a data-chapter> elements.
  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      // e.target may be a text node — walk up to the nearest element first.
      const el =
        e.target instanceof Element
          ? e.target
          : (e.target as Node).parentElement;
      const anchor = el?.closest("a[data-chapter]");
      if (!anchor) return;
      e.preventDefault();
      const ch = parseInt(anchor.getAttribute("data-chapter")!, 10);
      if (Number.isNaN(ch)) return;
      const frag = anchor.getAttribute("data-fragment");
      onLinkNavigate?.(ch, frag);
    },
    [onLinkNavigate],
  );

  return (
    <div ref={viewportRef} className="relative min-w-0 flex-1 overflow-hidden">
      <div className="absolute inset-0 flex items-center justify-center">
        {/* Clip to the current spread so neighbor columns can't bleed into the margins. */}
        <div
          className="overflow-hidden"
          style={{
            width: geom ? geom.contentWidth : "100%",
            height: geom ? geom.contentHeight : "100%",
            visibility: geom ? "visible" : "hidden",
          }}
        >
          <div
            ref={contentRef}
            lang="en"
            onClick={handleContentClick}
            onContextMenu={onContextMenu}
            className={`reader-content book-css text-reader${animate ? " transition-transform duration-200 ease-out" : ""}`}
            style={{
              width: geom ? geom.contentWidth : "100%",
              height: geom ? geom.contentHeight : "100%",
              columnWidth: geom ? geom.colWidth : undefined,
              columnGap: geom ? geom.colGap : undefined,
              columnFill: "auto",
              fontSize,
              lineHeight,
              transform: geom
                ? `translateX(${-spread * geom.perSpread * geom.stride}px)`
                : undefined,
            }}
          >
            {/* Drop the chapter opener down the page, book-style. */}
            <div aria-hidden style={{ height: 48 }} />
            {chapter.blocks.map((block, i) => {
              if (block.type === "image" && block.src) {
                const src = `yumi://asset/${block.src}`;
                return (
                  <img
                    key={i}
                    id={block.fragment || undefined}
                    data-b={i}
                    src={src}
                    alt={block.text || ""}
                    width={block.imgWidth}
                    height={block.imgHeight}
                    className="reader-image cursor-zoom-in"
                    onClick={() => setLightboxSrc(src)}
                  />
                );
              }

              const body = block.html ? (
                <span dangerouslySetInnerHTML={{ __html: block.html }} />
              ) : (
                block.text
              );
              const ttsClass =
                highlightBlockIndex === i ? "reader-tts-speaking" : "";
              const blockStyle = block.style
                ? ({ cssText: block.style } as React.CSSProperties)
                : undefined;
              if (block.type === "heading") {
                const level = Math.min(6, Math.max(1, block.level ?? 1));
                const Tag = `h${level}` as "h1";
                return (
                  <Tag
                    key={i}
                    id={block.fragment || undefined}
                    data-b={i}
                    style={blockStyle}
                    className={`${blockClasses(block, i, chapter.blocks)} ${ttsClass}`}
                  >
                    {body}
                  </Tag>
                );
              }
              return (
                <p
                  key={i}
                  id={block.fragment || undefined}
                  data-b={i}
                  style={blockStyle}
                  className={`${blockClasses(block, i, chapter.blocks)} ${ttsClass}`}
                >
                  {body}
                </p>
              );
            })}
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="reader-lightbox"
          onClick={() => setLightboxSrc(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setLightboxSrc(null);
          }}
        >
          <img src={lightboxSrc} alt="" className="reader-lightbox-img" />
        </div>
      )}

      {/* Margin click-zones turn pages, like Apple Books. */}
      {geom && (
        <>
          <button
            className="absolute inset-y-0 left-0 z-10 cursor-default outline-none"
            style={{ width: geom.margin + 16 }}
            onClick={goPrev}
            aria-label="Previous page"
            tabIndex={-1}
          />
          <button
            className="absolute inset-y-0 right-0 z-10 cursor-default outline-none"
            style={{ width: geom.margin + 16 }}
            onClick={goNext}
            aria-label="Next page"
            tabIndex={-1}
          />
        </>
      )}
    </div>
  );
}
