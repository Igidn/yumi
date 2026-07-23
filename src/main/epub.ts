import fs from "fs";
import path from "path";

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
import { getCoversDir } from "./paths";

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

/** Safety limits for image extraction so a malicious or manga-sized EPUB doesn't exhaust disk. */
const MAX_EXTRACTED_IMAGES = 500;
const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB per image

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

/** Resolve a relative href against a base spine item path. */
function resolveHref(base: string, rel: string): string {
  const baseDir = base.includes("/") ? base.substring(0, base.lastIndexOf("/") + 1) : "";
  const parts = (baseDir + rel).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }
  return resolved.join("/");
}

/**
 * Build a case-insensitive map from lowercase path → actual path for every
 * file in the EPUB archive. Many EPUBs (especially those authored on
 * case-insensitive file systems) reference `Images/photo.jpg` when the ZIP
 * entry is `images/photo.jpg` — epubjs does exact matches, so lookups fail.
 */
function buildFileMap(archive: any): Map<string, string> {
  const map = new Map<string, string>();
  const jszip = archive.zip;
  if (!jszip) return map;
  for (const key of Object.keys(jszip.files || {})) {
    if (jszip.files[key].dir) continue;
    // Normalize away leading/trailing slashes that JSZip may attach.
    const clean = key.replace(/^\/+/, "").replace(/\/+$/, "");
    if (clean) map.set(clean.toLowerCase(), clean);
  }
  return map;
}

/**
 * Walk the body of an XHTML document and emit structured blocks:
 * headings (h1–h6), paragraphs, and images. Nested block children of <p>
 * collapse into the paragraph text. <br> inside a paragraph becomes a line
 * break in html. <img> elements become image blocks when their src resolves
 * to a key in imageMap.
 */
function extractBlocks(
  doc: Document,
  imageMap?: Map<string, string>,
  docHref?: string
): ContentBlock[] {
  const body =
    doc.getElementsByTagName("body")[0] ||
    doc.documentElement.getElementsByTagName("body")[0];
  if (!body) return [];

  const blocks: ContentBlock[] = [];
  const skip = new Set(["script", "style", "head", "title", "meta", "link"]);

  function imageBlock(img: Element): ContentBlock | null {
    if (!imageMap || !docHref) return null;
    const src = img.getAttribute("src");
    if (!src) return null;
    const resolved = resolveHref(docHref, src);
    const savedPath = imageMap.get(resolved);
    if (!savedPath) return null;
    return {
      type: "image",
      text: (img.getAttribute("alt") || "").replace(/\s+/g, " ").trim(),
      src: savedPath,
    };
  }

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
        // If the only meaningful content is an image, emit an image block.
        const imgs = node.getElementsByTagName("img");
        if (imgs.length > 0 && !textOf(node)) {
          const block = imageBlock(imgs[0]);
          if (block) blocks.push(block);
          continue;
        }
        const block = makeBlock("paragraph", node);
        if (block) blocks.push(block);
        continue;
      }

      if (nsLocal === "img") {
        const block = imageBlock(node);
        if (block) blocks.push(block);
        continue;
      }

      // <figure> commonly wraps an <img>; grab the first img inside.
      if (nsLocal === "figure") {
        const imgs = node.getElementsByTagName("img");
        const block = imgs.length > 0 ? imageBlock(imgs[0]) : null;
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
      const isNav = tryPath === packaging.navPath && tryPath !== packaging.ncxPath;
      const items = isNav && typeof nav?.parseNav === "function"
        ? nav.parseNav(doc)
        : typeof nav?.parseNcx === "function"
          ? nav.parseNcx(doc)
          : [];
      if (items?.length) return flattenNav(items as NavItem[]);
    } catch {
      // ponytail: try the next path; failure here is not fatal — the nav-less
      // branch below still produces a usable (over-counted) chapter list.
    }
  }
  console.warn("[epub] nav parse failed for both NCX and nav paths; falling back to spine walk");

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
 * When `bookId` is provided, images referenced in the XHTML are extracted
 * from the archive and saved to `<userData>/covers/<bookId>/images/` so the
 * renderer can load them via the `yumi://asset/` protocol.
 *
 * @param filePath absolute path to a .epub
 * @param bookId database id, used as the image storage key
 */
export async function parseEpub(
  filePath: string,
  bookId?: number
): Promise<ParsedEpub> {
  const book = await openEpub(filePath);
  try {
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

  // Case-insensitive file map: many EPUBs (especially those authored on
  // Windows/macOS) reference files with different casing than the ZIP.
  const fileMap = bookId !== undefined ? buildFileMap(book.archive) : null;

  /** Like book.archive.getBlob, but falls back to case-insensitive lookup. */
  async function getImageBlob(href: string): Promise<Blob | null> {
    // epubjs getBlob does url.substr(1) internally, so it needs a leading /.
    const path = href.startsWith("/") ? href : `/${href}`;
    const direct = await book.archive.getBlob(path);
    if (direct) return direct;
    if (!fileMap) return null;
    const actual = fileMap.get(href.toLowerCase());
    if (!actual || actual === href) return null;
    const actualPath = actual.startsWith("/") ? actual : `/${actual}`;
    return (await book.archive.getBlob(actualPath)) ?? null;
  }

  // Book-wide image extraction state — shared across all chapters so
  // an image referenced from multiple chapters is only extracted once.
  const imageMap = new Map<string, string>();
  const imageDir =
    bookId !== undefined
      ? path.join(getCoversDir(), String(bookId), "images")
      : null;
  if (imageDir) fs.mkdirSync(imageDir, { recursive: true });

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

        // Extract images from this spine doc before DOM-walking.
        if (imageDir) {
          const imgs = doc.getElementsByTagName("img");
          // book.resolve() gives the full path from ZIP root, e.g.
          // text/cover.xhtml → /OEBPS/text/cover.xhtml. Strip the
          // leading / so resolveHref can compute relative paths.
          const docFullPath = book.resolve(item.href).replace(/^\/+/, "");
          for (let j = 0; j < imgs.length; j++) {
            const src = imgs[j].getAttribute("src");
            if (!src) continue;
            const resolved = resolveHref(docFullPath, src);
            if (imageMap.has(resolved)) continue;
            if (imageMap.size >= MAX_EXTRACTED_IMAGES) break;
            try {
              const blob = await getImageBlob(resolved);
              if (blob && blob.size > 0 && blob.size <= MAX_IMAGE_SIZE_BYTES) {
                const ext = pathExt(resolved) || "jpg";
                const filename = `${imageMap.size}.${ext}`;
                const dest = path.join(imageDir, filename);
                await fs.promises.writeFile(
                  dest,
                  Buffer.from(await blob.arrayBuffer())
                );
                imageMap.set(
                  resolved,
                  `covers/${bookId}/images/${filename}`
                );
              }
            } catch {
              // ponytail: skip unreadable images; the book still renders.
            }
          }
        }

        const docFullPath = book.resolve(item.href).replace(/^\/+/, "");
        allBlocks.push(...extractBlocks(doc, imageMap, docFullPath));
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

      if (imageDir) {
        const imgs = doc.getElementsByTagName("img");
        const docFullPath = book.resolve(item.href).replace(/^\/+/, "");
        for (let j = 0; j < imgs.length; j++) {
          const src = imgs[j].getAttribute("src");
          if (!src) continue;
          const resolved = resolveHref(docFullPath, src);
          if (imageMap.has(resolved)) continue;
          if (imageMap.size >= MAX_EXTRACTED_IMAGES) break;
          try {
            const blob = await getImageBlob(resolved);
            if (blob && blob.size > 0 && blob.size <= MAX_IMAGE_SIZE_BYTES) {
              const ext = pathExt(resolved) || "jpg";
              const filename = `${imageMap.size}.${ext}`;
              const dest = path.join(imageDir, filename);
              await fs.promises.writeFile(
                dest,
                Buffer.from(await blob.arrayBuffer())
              );
              imageMap.set(
                resolved,
                `covers/${bookId}/images/${filename}`
              );
            }
          } catch {
            // ponytail: skip unreadable images.
          }
        }
      }

      const docFullPath = book.resolve(item.href).replace(/^\/+/, "");
      const blocks = extractBlocks(doc, imageMap, docFullPath);
      if (blocks.length === 0) continue;
      chapters.push({
        index: chapters.length,
        title: chapterTitle(doc, `Chapter ${chapters.length + 1}`),
        rawText: JSON.stringify(blocks),
      });
    }
  }

  return { title, author, chapters };
  } finally {
    book.destroy();
  }
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