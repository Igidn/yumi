import fs from "fs";

// epubjs is a browser library: its Archive.getText reaches for
// `window.decodeURIComponent`. In the main process there is no window, so
// polyfill the handful of globals it actually touches before we import it.
// ponytail: minimal window shim — only what archive.getText/request needs.
if (typeof (globalThis as any).window === "undefined") {
  (globalThis as any).window = {
    decodeURIComponent: decodeURIComponent,
    URL: URL,
  };
}

import { Book, NavItem } from "epubjs";

/** A flat, renderer-ready block extracted from a chapter's XHTML. */
export interface ContentBlock {
  type: "heading" | "paragraph";
  level?: number; // heading level 1–6
  text: string;
}

export interface ParsedChapter {
  /** Order within the book, matching the OPF spine. */
  index: number;
  /** Title from the OPF/toc href, falling back to "Chapter N". */
  title: string;
  /** JSON-serialized ContentBlock[] — what goes into chapters.raw_text. */
  rawText: string;
}

export interface ParsedEpub {
  title: string;
  author: string;
  chapters: ParsedChapter[];
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function textOf(node: Element): string {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

/**
 * Walk the body of an XHTML document and emit structured blocks:
 * headings (h1–h6) and paragraphs. Nested block children of <p> collapse into
 * the paragraph text. <br> inside a paragraph becomes a space.
 */
function extractBlocks(doc: Document): ContentBlock[] {
  const body =
    doc.getElementsByTagName("body")[0] ||
    doc.documentElement.getElementsByTagName("body")[0];
  if (!body) return [];

  const blocks: ContentBlock[] = [];
  const skip = new Set(["script", "style", "head", "title", "meta", "link"]);

  function walk(el: Element): void {
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child.nodeType !== 1) continue; // elements only
      const node = child as Element;
      const local = node.localName || node.nodeName.toLowerCase();
      const nsLocal =
        local.indexOf(":") >= 0 ? local.split(":").slice(1).join(":") : local;

      if (skip.has(nsLocal)) continue;

      if (/^h[1-6]$/.test(nsLocal)) {
        const text = textOf(node);
        if (text) {
          blocks.push({ type: "heading", level: +nsLocal[1], text });
        }
        continue;
      }

      if (nsLocal === "p" || nsLocal === "blockquote") {
        const text = textOf(node);
        if (text) blocks.push({ type: "paragraph", text });
        continue;
      }

      // Unrecognized block: recurse — catches sections, divs, lists.
      // Lists become paragraphs per item to keep prose readable.
      if (nsLocal === "li") {
        const text = textOf(node);
        if (text) blocks.push({ type: "paragraph", text });
        continue;
      }

      walk(node);
    }
  }

  walk(body);
  return blocks;
}

function stripFragment(href: string): string {
  const i = href.indexOf("#");
  return i >= 0 ? href.slice(0, i) : href;
}

/** Flatten the EPUB nav (toc + subitems) into an href→label map. */
function buildNavIndex(toc: NavItem[]): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (items: NavItem[]) => {
    for (const item of items) {
      if (item.href && item.label) {
        // EPUB nav labels often carry stray whitespace from the NCX/XHTML
        // source; collapse it so the TOC sidebar renders clean titles.
        const label = item.label.replace(/\s+/g, " ").trim();
        if (!label) continue;
        // Key by both the raw href and its fragment-stripped form, so a
        // spine href without a fragment still matches a nav href with one.
        map.set(item.href, label);
        const base = stripFragment(item.href);
        if (!map.has(base)) map.set(base, label);
      }
      if (item.subitems) visit(item.subitems);
    }
  };
  visit(toc);
  return map;
}

function chapterTitle(
  doc: Document,
  navLabel: string | undefined,
  fallback: string
): string {
  // EPUB nav (toc.ncx / nav.xhtml) gives clean chapter titles; prefer it
  // over the file's <h1>/<title>, which in many books is boilerplate
  // (e.g. a Project Gutenberg header repeated on every section).
  if (navLabel) return navLabel;
  const h1 =
    doc.getElementsByTagName("h1")[0] || doc.getElementsByTagName("h2")[0];
  if (h1) {
    const t = textOf(h1);
    if (t) return t;
  }
  const title = doc.getElementsByTagName("title")[0];
  if (title) {
    const t = textOf(title);
    if (t) return t;
  }
  return fallback;
}

/**
 * Parse an EPUB file from disk into structured chapters.
 *
 * Flow: read file → epubjs opens the zip + OPF → read spine in order →
 * load each section's XHTML from the archive → DOM-walk into blocks.
 *
 * @param filePath absolute path to a .epub
 */
export async function parseEpub(filePath: string): Promise<ParsedEpub> {
  const data = await fs.promises.readFile(filePath);

  const book = new Book(data as any, { openAs: "binary" } as any);
  await book.opened;
  // `ready` resolves once spine/metadata/navigation are all loaded.
  await book.ready;

  const meta = (book as any).packaging?.metadata || {};
  const title: string =
    meta.title || (meta.dcTitle && meta.dcTitle[""]) || "Untitled";
  const author: string = meta.creator || "";

  // Build a href→label index from the EPUB navigation so chapter titles come
  // from the TOC the M1 sidebar will render, not the file's own <title>.
  const nav = (await book.loaded.navigation) as any;
  const navIndex = nav?.toc ? buildNavIndex(nav.toc as NavItem[]) : new Map<string, string>();

  // Collect spine sections in order, skipping non-linear (cover, etc.).
  const spineItems: SpineItemLike[] = [];
  (book.spine as any).each((section: any) => {
    if (section.linear !== false) spineItems.push(section);
  });

  const chapters: ParsedChapter[] = [];
  for (let i = 0; i < spineItems.length; i++) {
    const section = spineItems[i];
    const fallback = `Chapter ${i + 1}`;
    let doc: Document;
    try {
      // book.load routes through archive.request (no XHR) since archived=true.
      doc = (await book.load(section.href)) as unknown as Document;
    } catch {
      // ponytail: skip unreadable spine items rather than aborting the book.
      continue;
    }
    const sectionHref = stripFragment(section.href);
    const navLabel = navIndex.get(section.href) || navIndex.get(sectionHref);
    const title2 = chapterTitle(doc, navLabel, `Chapter ${i + 1}`);
    const blocks = extractBlocks(doc);
    if (blocks.length === 0) continue; // empty section (cover pages, etc.)
    chapters.push({
      index: i,
      title: title2,
      rawText: JSON.stringify(blocks),
    });
  }

  book.destroy();
  return { title, author, chapters };
}

interface SpineItemLike {
  href: string;
  index: number;
  linear: boolean | string;
}

// Self-check: `tsx src/main/epub.ts <file.epub>` prints a one-line summary.
// ponytail: tiny assertion run, no test framework.
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx src/main/epub.ts <file.epub>");
    process.exit(1);
  }
  const parsed = await parseEpub(file);
  console.log(
    `title="${parsed.title}" author="${parsed.author}" chapters=${parsed.chapters.length}`
  );
  const first = parsed.chapters[0];
  if (first) {
    const blocks: ContentBlock[] = JSON.parse(first.rawText);
    console.log(`  ch0 "${first.title}": ${blocks.length} blocks`);
    console.log(`  first block: ${JSON.stringify(blocks[0])}`);
  }
  assert(parsed.chapters.length > 0, "parsed chapters empty");
  console.log("OK");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("ASSERT FAILED: " + msg);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}