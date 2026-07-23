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
import type { ContentBlock } from "../shared/types";

export type { ContentBlock };

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

/** Cover bytes pulled out of an EPUB for the library grid. */
export interface EpubCover {
  data: Buffer;
  /** File extension without dot, e.g. "jpg". */
  ext: string;
}

export interface EpubMeta {
  title: string;
  author: string;
  cover: EpubCover | null;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function textOf(node: Element): string {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

/** Inline tags that survive into ContentBlock.html; everything else unwraps. */
const INLINE_TAG_MAP: Record<string, string> = {
  em: "em",
  i: "em",
  strong: "strong",
  b: "strong",
};

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Serialize a node's inline content to safe minimal HTML: text nodes are
 * escaped, <em>/<strong>/<br> are kept, every other element is unwrapped and
 * all attributes are dropped. The output is the only thing the renderer ever
 * injects via dangerouslySetInnerHTML, which keeps EPUB-sourced markup from
 * smuggling in scripts or styles.
 */
function inlineHtml(node: Node): string {
  let out = "";
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === 3) {
      out += escapeHtmlText(child.textContent || "");
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const local = (el.localName || el.nodeName).toLowerCase();
    if (local === "script" || local === "style") continue;
    if (local === "br") {
      out += "<br/>";
      continue;
    }
    const inner = inlineHtml(el);
    const tag = INLINE_TAG_MAP[local];
    out += tag && inner.trim() ? `<${tag}>${inner}</${tag}>` : inner;
  }
  return out;
}

/**
 * Collapse whitespace the way textOf does, but per <br>-separated segment so
 * line breaks survive. Empty segments (leading/trailing <br>) are dropped.
 */
function collapseInlineHtml(html: string): string {
  return html
    .split(/<br\s*\/?>/)
    .map((seg) => seg.replace(/\s+/g, " ").trim())
    .filter((seg) => seg.length > 0)
    .join("<br/>");
}

/** Build a block from an element, attaching html only when markup remains. */
function makeBlock(
  type: ContentBlock["type"],
  node: Element,
  level?: number
): ContentBlock | null {
  const text = textOf(node);
  if (!text) return null;
  const html = collapseInlineHtml(inlineHtml(node));
  const block: ContentBlock = { type, text };
  if (level !== undefined) block.level = level;
  if (html.includes("<")) block.html = html;
  return block;
}

/**
 * Walk the body of an XHTML document and emit structured blocks:
 * headings (h1–h6) and paragraphs. Nested block children of <p> collapse into
 * the paragraph text. <br> inside a paragraph becomes a line break in html.
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
        const block = makeBlock("heading", node, +nsLocal[1]);
        if (block) blocks.push(block);
        continue;
      }

      if (nsLocal === "p" || nsLocal === "blockquote") {
        const block = makeBlock("paragraph", node);
        if (block) blocks.push(block);
        continue;
      }

      // Unrecognized block: recurse — catches sections, divs, lists.
      // Lists become paragraphs per item to keep prose readable.
      if (nsLocal === "li") {
        const block = makeBlock("paragraph", node);
        if (block) blocks.push(block);
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

/** Flatten the EPUB nav (toc + subitems) into a single ordered list. */
function flattenNav(toc: NavItem[]): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  const visit = (items: NavItem[]) => {
    for (const item of items) {
      if (item.href && item.label) {
        // EPUB nav labels often carry stray whitespace from the NCX/XHTML
        // source; collapse it so the TOC sidebar renders clean titles.
        const label = item.label.replace(/\s+/g, " ").trim();
        if (label) out.push({ label, href: item.href });
      }
      if (item.subitems) visit(item.subitems);
    }
  };
  visit(toc);
  return out;
}

/**
 * Fallback nav loader for when epubjs's auto-loaded `book.navigation` ends
 * up empty (its `parse()` misidentifies the root of some XHTML nav docs).
 * Tries toc.ncx first (almost always present), then nav.xhtml.
 */
async function loadNavManually(
  book: Book,
  nav: any
): Promise<{ label: string; href: string }[]> {
  const packaging: any = (book as any).packaging;
  for (const tryPath of [packaging?.ncxPath, packaging?.navPath]) {
    if (!tryPath) continue;
    try {
      const doc = (await book.load(tryPath)) as unknown as Document;
      const items =
        typeof nav?.parseNcx === "function"
          ? nav.parseNcx(doc)
          : typeof nav?.parseNav === "function"
          ? nav.parseNav(doc)
          : [];
      if (items?.length) return flattenNav(items as NavItem[]);
    } catch {
      // ponytail: try the next path; failure here is not fatal — the nav-less
      // branch below still produces a usable (over-counted) chapter list.
    }
  }
  return [];
}

function chapterTitle(doc: Document, fallback: string): string {
  // Nav-less fallback: read the title from the document itself. EPUB nav is
  // the preferred source — many books stamp boilerplate in <h1>/<title>
  // (e.g. a Project Gutenberg header repeated on every section).
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

function metadataOf(book: Book): { title: string; author: string } {
  const meta = (book as any).packaging?.metadata || {};
  const title: string =
    meta.title || (meta.dcTitle && meta.dcTitle[""]) || "Untitled";
  const author: string = meta.creator || "";
  return { title, author };
}

function extFromCover(coverHref: string, mime: string | undefined): string {
  const fromMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };
  if (mime && fromMime[mime]) return fromMime[mime];
  const ext = pathExt(coverHref);
  return ext || "img";
}

function pathExt(href: string): string {
  const clean = stripFragment(href);
  const base = clean.split("/").pop() || clean;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

async function openEpub(filePath: string): Promise<Book> {
  const data = await fs.promises.readFile(filePath);
  const book = new Book(data as any, { openAs: "binary" } as any);
  await book.opened;
  // `ready` resolves once spine/metadata/navigation are all loaded.
  await book.ready;
  return book;
}

/** Pull cover image bytes out of an already-opened epubjs Book. */
async function coverOf(book: Book): Promise<EpubCover | null> {
  const coverHref = (book as any).cover as string | undefined;
  if (!coverHref || !book.archive) return null;
  try {
    const blob: Blob | undefined = await book.archive.getBlob(coverHref);
    if (!blob) return null;
    const data = Buffer.from(await blob.arrayBuffer());
    if (data.length === 0) return null;
    return { data, ext: extFromCover(coverHref, blob.type) };
  } catch {
    // ponytail: missing/unreadable cover is fine — library shows a placeholder.
    return null;
  }
}

/**
 * Lightweight import-time read: title, author, cover. Skips chapter parsing.
 */
export async function readEpubMeta(filePath: string): Promise<EpubMeta> {
  const book = await openEpub(filePath);
  try {
    const { title, author } = metadataOf(book);
    const cover = await coverOf(book);
    return { title, author, cover };
  } finally {
    book.destroy();
  }
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
  const book = await openEpub(filePath);
  const { title, author } = metadataOf(book);

  // The EPUB nav is the source of truth for chapter boundaries — many books
  // split a single chapter across several XHTML files (text + image + text)
  // to keep file sizes small, so walking the spine (file-level) inflates the
  // chapter count and produces duplicate entries. The nav (toc.ncx /
  // nav.xhtml) lists each logical chapter once.
  //
  // epubjs's `book.loaded.navigation` is unreliable: it returns an empty toc
  // for EPUBs whose nav.xhtml isn't recognised as HTML, which silently
  // re-introduces the duplication bug. Parse the toc.ncx (or nav.xhtml as a
  // fallback) ourselves so the flat nav is correct on every book.
  const nav = (await book.loaded.navigation) as any;
  let flatNav: { label: string; href: string }[] = nav?.toc?.length
    ? flattenNav(nav.toc as NavItem[])
    : await loadNavManually(book, nav);

  // Collect linear spine sections in order, indexed by fragment-stripped
  // href so a nav entry like `section-0009.html#auto_bookmark_toc_9` finds
  // the matching file.
  interface SpineRef {
    index: number;
    href: string;
  }
  const spineItems: SpineRef[] = [];
  const spineByHref = new Map<string, SpineRef>();
  let spineIndex = 0;
  (book.spine as any).each((section: any) => {
    if (section.linear === false) return;
    const item: SpineRef = { index: spineIndex++, href: section.href };
    spineItems.push(item);
    const base = stripFragment(section.href);
    if (!spineByHref.has(base)) spineByHref.set(base, item);
  });

  const chapters: ParsedChapter[] = [];
  if (flatNav.length > 0) {
    for (let i = 0; i < flatNav.length; i++) {
      const entry = flatNav[i];
      const startHref = stripFragment(entry.href);
      const startItem = spineByHref.get(startHref);
      if (!startItem) continue; // nav points outside the spine — skip
      // A chapter spans every spine section from its start up to (but not
      // including) the next nav entry's start. The last chapter runs to
      // the end of the spine.
      const nextStartHref =
        i + 1 < flatNav.length ? stripFragment(flatNav[i + 1].href) : null;
      const nextStartIndex = nextStartHref
        ? spineByHref.get(nextStartHref)?.index ?? spineItems.length
        : spineItems.length;
      const allBlocks: ContentBlock[] = [];
      for (const item of spineItems) {
        if (item.index < startItem.index) continue;
        if (item.index >= nextStartIndex) break;
        let doc: Document;
        try {
          // book.load routes through archive.request (no XHR) since archived=true.
          doc = (await book.load(item.href)) as unknown as Document;
        } catch {
          // ponytail: skip unreadable spine items rather than aborting the book.
          continue;
        }
        allBlocks.push(...extractBlocks(doc));
      }
      if (allBlocks.length === 0) continue;
      chapters.push({
        index: chapters.length,
        title: entry.label,
        rawText: JSON.stringify(allBlocks),
      });
    }
  } else {
    // ponytail: nav-less fallback (rare — books without toc.ncx/nav.xhtml);
    // file-level spine iteration over-counts chapters the same way as the
    // buggy version, but the renderer still renders *something*.
    for (let i = 0; i < spineItems.length; i++) {
      const item = spineItems[i];
      let doc: Document;
      try {
        doc = (await book.load(item.href)) as unknown as Document;
      } catch {
        continue;
      }
      const blocks = extractBlocks(doc);
      if (blocks.length === 0) continue;
      chapters.push({
        index: chapters.length,
        title: chapterTitle(doc, `Chapter ${chapters.length + 1}`),
        rawText: JSON.stringify(blocks),
      });
    }
  }

  book.destroy();
  return { title, author, chapters };
}

// Self-check: `tsx src/main/epub.ts <file.epub>` prints a one-line summary.
// ponytail: tiny assertion run, no test framework.
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx src/main/epub.ts <file.epub>");
    process.exit(1);
  }
  const meta = await readEpubMeta(file);
  console.log(
    `meta title="${meta.title}" author="${meta.author}" cover=${meta.cover ? meta.cover.ext + " " + meta.cover.data.length + "b" : "none"}`
  );
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
  assert(parsed.title === meta.title, "meta/parse title mismatch");
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