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
}

/** Offscreen CSS-column count for one chapter under a known layout. */
export function countChapterCols(
  chapter: ReaderChapter,
  layout: Pick<
    SpreadInfo,
    "contentWidth" | "contentHeight" | "colWidth" | "colGap"
  >,
  fontSize: number,
  lineHeight: number
): number {
  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none";
  const content = document.createElement("div");
  content.className = "reader-content";
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
      content.appendChild(img);
      // ponytail: images loaded async won't have height yet; use a
      // conservative placeholder so column counting isn't wildly off.
      const ph = document.createElement("div");
      ph.style.height = `${layout.colWidth * 0.75}px`;
      content.appendChild(ph);
      return;
    }
    if (block.type === "heading") {
      const level = Math.min(6, Math.max(1, block.level ?? 1));
      const el = document.createElement(`h${level}`);
      el.className = headingClass(level, i === 0);
      if (block.html) el.innerHTML = block.html;
      else el.textContent = block.text;
      content.appendChild(el);
      return;
    }
    const p = document.createElement("p");
    if (i > 0 && chapter.blocks[i - 1].type === "paragraph") {
      p.className = "reader-indent";
    }
    if (block.html) p.innerHTML = block.html;
    else p.textContent = block.text;
    content.appendChild(p);
  });

  host.appendChild(content);
  document.body.appendChild(host);
  const stride = layout.colWidth + layout.colGap;
  const totalCols = Math.max(
    1,
    Math.round((content.scrollWidth + layout.colGap) / stride)
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

  // Chapter switch: drop geometry (hides content) and reseed the position.
  // This is the render-time derived-state reset pattern; the layout effect
  // below re-measures and re-positions before the next paint.
  const chapterForState = useRef(chapter.id);
  if (chapterForState.current !== chapter.id) {
    chapterForState.current = chapter.id;
    setGeom(null);
    setSpread(0);
    fractionRef.current = initialFraction;
    lastJumpNonce.current = 0;
    lastRepositionNonce.current = 0;
  }

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
      Math.max(1, Math.ceil(Math.floor(availW) / Math.floor(MAX_INLINE_SIZE)))
    );
    // Keep at least MARGIN_X on each side so text never kisses the window edge.
    const innerW = Math.max(0, availW - MARGIN_X * 2);
    // gap = a/(1-a) * size keeps outer padding and column gap visually even.
    const colGap =
      perSpread > 1
        ? Math.round((-GAP_PERCENT / (GAP_PERCENT - 1)) * innerW)
        : 0;
    const colWidth = Math.floor(
      Math.min((innerW - colGap * (perSpread - 1)) / perSpread, MAX_INLINE_SIZE)
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
      Math.round((content.scrollWidth + colGap) / stride)
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
      })
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
    const el = content.querySelector<HTMLElement>(`[data-b="${jump.blockIndex}"]`);
    if (!el) return;
    const target = Math.floor(el.offsetLeft / (geom.stride * geom.perSpread));
    setSpread(Math.min(Math.max(0, target), geom.spreads - 1));
    el.classList.add("reader-flash");
    const timer = setTimeout(() => el.classList.remove("reader-flash"), 1700);
    return () => clearTimeout(timer);
  }, [jump, geom]);

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
            className={`reader-content text-reader${animate ? " transition-transform duration-200 ease-out" : ""}`}
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
                    data-b={i}
                    src={src}
                    alt={block.text || ""}
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
              if (block.type === "heading") {
                const level = Math.min(6, Math.max(1, block.level ?? 1));
                const Tag = `h${level}` as "h1";
                return (
                  <Tag key={i} data-b={i} className={headingClass(level, i === 0)}>
                    {body}
                  </Tag>
                );
              }
              // Book convention: no indent on a paragraph right after a
              // heading; every paragraph after another paragraph is indented.
              const indent = i > 0 && chapter.blocks[i - 1].type === "paragraph";
              return (
                <p key={i} data-b={i} className={indent ? "reader-indent" : undefined}>
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
          onKeyDown={(e) => { if (e.key === "Escape") setLightboxSrc(null); }}
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
