import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { net } from "electron";
import fs from "fs";
import path from "path";

import type { ContentBlock, ImportOutcome } from "../shared/types";
import { getDb } from "./database";
import { books, chapters } from "./db/schema";
import { bookForRenderer, deleteBook } from "./import";
import { getCoversDir } from "./paths";

const SITE_HOST = "freewebnovel.com";

/**
 * Chrome-like UA/headers. The site sits behind Cloudflare; a bare undici
 * fetch is rejected (403) on TLS fingerprint, but Electron's `net.fetch`
 * rides Chromium's network stack and passes. Headers still need to look
 * like a real browser, though.
 */
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

export interface WebnovelChapterLink {
  url: string;
  title: string;
}

interface WebnovelMeta {
  title: string;
  author: string;
  coverUrl: string | null;
  totalChapters: number;
}

/**
 * Accept `https://freewebnovel.com/novel/{slug}` (with or without `.html`,
 * and with or without a trailing `/chapter-N`), return the canonical novel
 * URL. Throws on anything that isn't a freewebnovel novel page.
 */
function normalizeNovelUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Not a freewebnovel.com link.");
  }
  if (u.hostname.toLowerCase() !== SITE_HOST) {
    throw new Error("Only freewebnovel.com novel links are supported.");
  }
  const match = u.pathname.match(/^\/novel\/([^/]+?)(?:\.html)?(?:\/.*)?$/i);
  if (!match) {
    throw new Error(
      "Paste a freewebnovel.com novel link, e.g. https://freewebnovel.com/novel/...",
    );
  }
  return `https://${SITE_HOST}/novel/${match[1].toLowerCase()}`;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, "\u00a0")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");
}

/** Content of a `<meta property="..." content="...">` tag, decoded. */
function metaContent(html: string, property: string): string | null {
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const prop = tag.match(/\bproperty\s*=\s*["']([^"']*)["']/i);
    if (prop && prop[1].toLowerCase() === property) {
      const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
      if (content && content[1]) return decodeEntities(content[1]).trim();
    }
  }
  return null;
}

/** Pull one `name="value"` attribute out of the HTML. */
function dataAttr(html: string, attr: string): string | null {
  const m = html.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

/** Parse the novel page's `og:novel:*` meta + chapter-count attributes. */
function parseNovelMeta(html: string): WebnovelMeta {
  const title =
    metaContent(html, "og:novel:novel_name") ??
    metaContent(html, "og:title") ??
    "";
  const author = metaContent(html, "og:novel:author") ?? "";
  const coverUrl = metaContent(html, "og:image");
  const totalChapters =
    parseInt(dataAttr(html, "data-total-chapters") ?? "", 10) || 0;
  if (!title) {
    throw new Error(
      "Couldn't parse that as a novel — is it a freewebnovel.com novel page?",
    );
  }
  if (totalChapters === 0) {
    throw new Error("Couldn't read the chapter list for this novel.");
  }
  return { title, author, coverUrl, totalChapters };
}

/**
 * Extract chapter links from a chapter-list fragment. Chapters render as
 * `<a href="..." title="...">` inside `<ul id="idData">`; the site's AJAX
 * pagination (`?ajax=chapters`) returns that same inner HTML with the `title`
 * attribute carrying the full chapter name. Any non-chapter anchors are
 * avoided by feeding this only the idData inner HTML (first page) or an AJAX
 * fragment (pages 2+).
 */
function parseChapterLinks(
  fragment: string,
  baseUrl: string,
): WebnovelChapterLink[] {
  const links: WebnovelChapterLink[] = [];
  const tagRe = /<a\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(fragment))) {
    const tag = m[0];
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const title = tag.match(/\btitle\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!href) continue;
    let url: string;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    links.push({ url, title: title ? decodeEntities(title).trim() : "" });
  }
  return links;
}

/**
 * The chapter list is paginated by the site's own JS via an AJAX JSON
 * endpoint (`?ajax=chapters&page=N&pageSize=M`), not a plain `?page=` param.
 * The page numbering is relative to the requested pageSize, so every page
 * (including page 1) must use the same pageSize or chapters get skipped.
 * 200 per page is the largest the server accepts and keeps the request count
 * low. Fetched sequentially with a small delay: the Cloudflare frontend
 * rate-limits bursty requests (HTTP 429).
 */
const CHAPTERS_PER_PAGE = 200;

async function fetchAllChapters(
  novelUrl: string,
  totalChapters: number,
): Promise<WebnovelChapterLink[]> {
  const totalListPages = Math.max(
    1,
    Math.ceil(totalChapters / CHAPTERS_PER_PAGE),
  );
  const pageUrls = Array.from({ length: totalListPages }, (_, i) => {
    return `${novelUrl}?ajax=chapters&page=${i + 1}&pageSize=${CHAPTERS_PER_PAGE}`;
  });
  const chapters: WebnovelChapterLink[] = [];
  for (const [i, pageUrl] of pageUrls.entries()) {
    if (i > 0) await sleep(250);
    const fragment = await fetchFragmentWithRetry(pageUrl);
    chapters.push(...parseChapterLinks(fragment, novelUrl));
  }
  return chapters;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await net.fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (HTTP ${res.status})`);
  }
  return res.text();
}

/**
 * Fetch one chapter-list page via the site's AJAX endpoint, returning the
 * inner HTML of the chapter list. The response is JSON: `{ code, html, ... }`.
 */
async function fetchChapterFragment(url: string): Promise<string> {
  const res = await net.fetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (HTTP ${res.status})`);
  }
  let data: { code?: number; html?: string };
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new Error(`Unexpected response from ${url}`);
  }
  if (data.code !== 200) {
    throw new Error(`Failed to load chapter list (code ${data.code})`);
  }
  return data.html ?? "";
}

/** Wait helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a fetcher with a small retry/backoff on transient failures. The site is
 * Cloudflare-fronted and rate-limits bursty fetches (HTTP 429), so the
 * chapter-list walk must be polite rather than hammer it with parallel
 * requests.
 */
async function withRetry<T>(
  fetcher: (url: string) => Promise<T>,
  url: string,
  attempts = 4,
): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetcher(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i === attempts - 1) break;
      // Backoff, doubling with jitter: ~600ms, ~1.2s, ~2.4s.
      const base = 600 * 2 ** i;
      await sleep(base + Math.floor(Math.random() * base));
    }
  }
  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

function fetchHtmlWithRetry(url: string): Promise<string> {
  return withRetry(fetchHtml, url);
}

function fetchFragmentWithRetry(url: string): Promise<string> {
  return withRetry(fetchChapterFragment, url);
}

/**
 * Watermark/anti-scraping noise freewebnovel mixes into chapter text. Any
 * paragraph matching one of these is dropped entirely. The "Freewebnᴏvel"
 * spelling uses an obfuscated o, hence the fuzzy `\w*` in the pattern.
 */
const WATERMARK_PATTERNS: RegExp[] = [
  /new novel chapters are published on freewebnovel\.com/i,
  /the source of this content is freewebn\w*vel\.com/i,
  /we are moving freewebnovel\.com to libread\.com/i,
  /this story originates from/i,
  /ensure the author gets the support/i,
];

function isWatermark(text: string): boolean {
  return WATERMARK_PATTERNS.some((re) => re.test(text));
}

/**
 * Extract the inner HTML of the chapter-text container: `<div id="article">`
 * on current pages, `<div class="txt">` on older ones. Tracks nested divs so
 * the match ends at the container's real close tag, not the first `</div>`.
 * Returns null when neither container is present.
 */
function extractArticleInner(html: string): string | null {
  const startRe = /<div\b[^>]*\bid\s*=\s*["']article["'][^>]*>/i;
  let start = startRe.exec(html);
  if (!start) {
    start = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\btxt\b[^"']*["'][^>]*>/i.exec(
      html,
    );
  }
  if (!start) return null;

  let depth = 0;
  let i = start.index + start[0].length;
  const n = html.length;
  let end = n;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const gt = html.indexOf(">", lt);
    if (gt === -1) break;
    const tag = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (tag.startsWith("/") && tag.length > 1) {
      depth--;
      if (depth === 0) {
        end = lt;
        break;
      }
    } else if (/^div\b/i.test(tag) && !/\/$/.test(tag)) {
      depth++;
    }
  }
  let inner = html.slice(start.index + start[0].length, end);
  // The article div also wraps the chapter's comments widget (its own
  // container divs balance the depth, so it survives the walk above). Cut
  // everything from the comments section on — story text ends before it.
  const commentsIdx = inner.search(
    /<div\b[^>]*\bid\s*=\s*["']readerPageComments["']/i,
  );
  if (commentsIdx !== -1) inner = inner.slice(0, commentsIdx);
  return inner;
}

/** Drop script/style/noscript blocks before paragraph splitting. */
function stripScripts(inner: string): string {
  return inner.replace(
    /<(script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
}

/** Inline emphasis mapping: mirror the EPUB parser's whitelist. */
const INLINE_EMPH: Record<string, string> = {
  em: "em",
  i: "em",
  strong: "strong",
  b: "strong",
  sup: "sup",
};

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Walk one block's inline HTML, producing both the plain text (TTS/search)
 * and a minimal-whitelist HTML string (em/strong/br/sup kept; a/span/div
 * unwrapped; <sub> dropped — the site hides watermark fragments in them).
 * Tolerates broken markup: unknown tags are unwrapped, comments skipped,
 * and an unclosed <sub> stops eating at the end of the block.
 */
function parseWebnovelInline(input: string): { text: string; html: string } {
  let text = "";
  const parts: string[] = [];
  const stack: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      const piece = decodeEntities(input.slice(i));
      text += piece;
      parts.push(escapeHtmlText(piece));
      break;
    }
    const piece = decodeEntities(input.slice(i, lt));
    text += piece;
    parts.push(escapeHtmlText(piece));
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      i = n;
      continue;
    }
    const raw = input.slice(lt + 1, gt).trim();
    i = gt + 1;
    const name = raw.match(/^\/?([a-zA-Z][a-zA-Z0-9]*)/)?.[1]?.toLowerCase();
    if (!name) continue;
    const closing = raw.startsWith("/");
    if (name === "br") {
      text += " ";
      parts.push("<br/>");
      continue;
    }
    if (name === "sub") {
      const closeIdx = input.toLowerCase().indexOf("</sub", i);
      if (closeIdx === -1) {
        i = n;
        continue;
      }
      const closeGt = input.indexOf(">", closeIdx);
      i = closeGt === -1 ? n : closeGt + 1;
      continue;
    }
    if (closing) {
      if (stack[stack.length - 1] === name) {
        stack.pop();
        parts.push(`</${name}>`);
      }
      continue;
    }
    const mapped = INLINE_EMPH[name];
    if (mapped) {
      stack.push(mapped);
      parts.push(`<${mapped}>`);
    }
  }
  const html = parts
    .join("")
    .split(/<br\s*\/?>/)
    .map((seg) => seg.replace(/\s+/g, " ").trim())
    .filter((seg) => seg.length > 0)
    .join("<br/>");
  return { text: text.replace(/\s+/g, " ").trim(), html };
}

/** Turn a `<p>`/heading's inner HTML into a reader block, or null if empty. */
function paragraphToBlock(inner: string, level?: number): ContentBlock | null {
  const { text, html } = parseWebnovelInline(inner);
  if (!text || isWatermark(text)) return null;
  const block: ContentBlock = level
    ? { type: "heading", text, level }
    : { type: "paragraph", text };
  if (html.includes("<")) block.html = html;
  return block;
}

/**
 * Parse a chapter page's article container into reader blocks. Chapter text
 * is a run of `<p>` elements; anything else (ad divs, scripts) is ignored by
 * construction. Chapters rendered without `<p>` tags fall back to splitting
 * on `<br>`.
 */
function chapterHtmlToBlocks(articleHtml: string): ContentBlock[] {
  const inner = stripScripts(articleHtml);
  const blocks: ContentBlock[] = [];
  const pRe = /<(?:p|h([1-6]))\b[^>]*>([\s\S]*?)<\/(?:p|h\1)\s*>/gi;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = pRe.exec(inner))) {
    matched = true;
    const level = m[1] ? Number(m[1]) : undefined;
    const block = paragraphToBlock(m[2], level);
    if (block) blocks.push(block);
  }
  if (!matched) {
    for (const seg of inner.split(/<br\s*\/?>/i)) {
      const block = paragraphToBlock(seg);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

/**
 * Fetch one chapter page and extract its text as reader blocks. This is the
 * reader flow: called on first open / chapter change, then the result is
 * cached in `chapters.rawText` so revisiting the chapter is instant.
 * Throws when the page can't be fetched or has no parseable text container.
 */
export async function fetchWebnovelChapterBlocks(
  chapterUrl: string,
): Promise<ContentBlock[]> {
  const html = await fetchHtmlWithRetry(chapterUrl);
  const inner = extractArticleInner(html);
  if (!inner) {
    throw new Error("Couldn't find the chapter text on the page.");
  }
  const blocks = chapterHtmlToBlocks(inner);
  if (blocks.length === 0) {
    throw new Error("Couldn't parse any text from this chapter.");
  }
  return blocks;
}

function extFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const byMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };
  const type = contentType.toLowerCase();
  for (const [mime, ext] of Object.entries(byMime)) {
    if (type.startsWith(mime)) return ext;
  }
  return null;
}

async function fetchCover(url: string): Promise<Response> {
  const res = await net.fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function downloadCover(
  coverUrl: string,
  novelUrl: string,
): Promise<string> {
  const res = await withRetry(fetchCover, coverUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  const fromUrl = coverUrl.match(/\.([a-z0-9]{3,4})$/i)?.[1]?.toLowerCase();
  const ext =
    extFromContentType(res.headers.get("content-type")) ?? fromUrl ?? "jpg";
  const key = createHash("sha256").update(novelUrl).digest("hex").slice(0, 24);
  const dest = path.join(getCoversDir(), `webnovel-${key}.${ext}`);
  await fs.promises.writeFile(dest, buf);
  return dest;
}

/**
 * Import a freewebnovel.com novel: fetch the page, cache cover/title/author
 * and the full chapter list (URL + title per chapter) as chapter rows.
 *
 * Dedup is keyed on the canonical novel URL (no file hash exists for a
 * webnovel), mirroring `importBook`'s prompt/skip/replace semantics.
 */
export async function importWebnovel(
  url: string,
  duplicateHandling: "skip" | "replace" | "prompt" = "prompt",
): Promise<ImportOutcome> {
  const novelUrl = normalizeNovelUrl(url);
  const db = await getDb();

  const existing = (
    await db
      .select()
      .from(books)
      .where(
        and(
          eq(books.format, "webnovel"),
          eq(books.sourcePath, novelUrl),
          eq(books.trashed, 0),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    if (duplicateHandling === "prompt") {
      return { status: "duplicate", existingBook: bookForRenderer(existing) };
    }
    if (duplicateHandling === "skip") {
      return { status: "skipped", existingBook: bookForRenderer(existing) };
    }
  }

  const html = await fetchHtmlWithRetry(novelUrl);
  const meta = parseNovelMeta(html);
  const chapterLinks = await fetchAllChapters(novelUrl, meta.totalChapters);
  if (chapterLinks.length === 0) {
    throw new Error("Couldn't read any chapters from this novel.");
  }

  // Only delete the existing book once the replacement has been fetched and
  // parsed successfully; a failed fetch must not lose progress/notes/drawings.
  if (existing) {
    await deleteBook(existing.id);
  }

  let coverPath: string | null = null;
  if (meta.coverUrl) {
    try {
      coverPath = await downloadCover(meta.coverUrl, novelUrl);
    } catch (err) {
      // Keep the import; a missing cover is cosmetic.
      console.error("[webnovel] cover download failed:", meta.coverUrl, err);
    }
  }

  const rows = await db
    .insert(books)
    .values({
      title: meta.title,
      author: meta.author,
      format: "webnovel",
      sourcePath: novelUrl,
      sha256: null,
      coverPath,
      importedAt: new Date().toISOString(),
    })
    .returning();
  const book = rows[0];

  // Chapter text is fetched on first read (reader flow); cache the URL +
  // title now so the list is available offline.
  db.insert(chapters)
    .values(
      chapterLinks.map((link, i) => ({
        bookId: book.id,
        title: link.title || `Chapter ${i + 1}`,
        index: i,
        sourceUrl: link.url,
        rawText: "",
      })),
    )
    .run();

  return {
    status: "imported",
    book: bookForRenderer(book),
    chapterCount: chapterLinks.length,
  };
}
