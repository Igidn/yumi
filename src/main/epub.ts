import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import type { ContentBlock } from "../shared/types";
import { getCoversDir } from "./paths";

export type { ContentBlock };

export interface ParsedChapter {
  index: number;
  title: string;
  rawText: string;
}

export interface ParsedEpub {
  title: string;
  author: string;
  chapters: ParsedChapter[];
}

export interface EpubCover {
  data: Buffer;
  ext: string;
}

export interface EpubMeta {
  title: string;
  author: string;
  cover: EpubCover | null;
}

export interface LinkTarget {
  chapterIndex: number;
  fragment?: string;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_EXTRACTED_IMAGES = 500;
const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// EPUB wrapper — replaces epubjs Book
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp",
};

class Epub {
  private zip: JSZip;
  /** case-insensitive path → actual zip entry path */
  private fileMap: Map<string, string>;
  opfDir: string;
  metadata: { title: string; creator: string };
  spine: Array<{ href: string; linear: string; index: number }>;
  navPath: string | null;
  ncxPath: string | null;
  coverHref: string | null;

  private constructor(zip: JSZip) {
    this.zip = zip;
    this.fileMap = new Map();
    this.opfDir = "";
    this.metadata = { title: "", creator: "" };
    this.spine = [];
    this.navPath = null;
    this.ncxPath = null;
    this.coverHref = null;
  }

  static async open(filePath: string): Promise<Epub> {
    const data = await fs.promises.readFile(filePath);
    const zip = await JSZip.loadAsync(data);

    // Build case-insensitive file map
    const fileMap = new Map<string, string>();
    for (const key of Object.keys(zip.files)) {
      if (zip.files[key].dir) continue;
      const clean = key.replace(/^\/+/, "").replace(/\/+$/, "");
      if (clean) fileMap.set(clean.toLowerCase(), clean);
    }

    // Parse container.xml
    const containerXml = await zip.file("META-INF/container.xml")?.async("string");
    if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");
    const containerDoc = parseXml(containerXml);
    const rootfile = containerDoc.getElementsByTagName("rootfile")[0];
    if (!rootfile) throw new Error("Invalid EPUB: no rootfile in container.xml");
    const opfPath = rootfile.getAttribute("full-path") || "";

    const epub = new Epub(zip);
    epub.fileMap = fileMap;
    epub.opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";

    // Parse OPF
    const opfXmlStr = await epub.readText(opfPath);
    if (!opfXmlStr) throw new Error("Invalid EPUB: OPF file not found");
    const opfDoc = parseXml(opfXmlStr);

    // Metadata
    epub.metadata = parseMetadata(opfDoc);

    // Manifest: id → { href, mediaType, properties }
    const manifest = new Map<string, { href: string; mediaType: string; properties: string[] }>();
    const manifestNode = opfDoc.getElementsByTagName("manifest")[0];
    if (manifestNode) {
      const items = manifestNode.getElementsByTagName("item");
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const id = item.getAttribute("id") || "";
        const href = item.getAttribute("href") || "";
        const mediaType = item.getAttribute("media-type") || "";
        const props = (item.getAttribute("properties") || "").split(/\s+/).filter(Boolean);
        manifest.set(id, { href, mediaType, properties: props });

        if (props.includes("nav")) epub.navPath = href;
        if (props.includes("cover-image")) epub.coverHref = href;
      }
    }

    // NCX path (EPUB2)
    if (!epub.ncxPath) {
      for (const [, m] of manifest) {
        if (m.mediaType === "application/x-dtbncx+xml") {
          epub.ncxPath = m.href;
          break;
        }
      }
    }

    // Spine
    const spineNode = opfDoc.getElementsByTagName("spine")[0];

    // Spine toc attribute fallback for NCX
    if (!epub.ncxPath && spineNode) {
      const tocId = spineNode.getAttribute("toc");
      if (tocId) {
        const m = manifest.get(tocId);
        if (m) epub.ncxPath = m.href;
      }
    }

    if (spineNode) {
      const spineItems = spineNode.getElementsByTagName("itemref");
      for (let i = 0; i < spineItems.length; i++) {
        const itemref = spineItems[i];
        const idref = itemref.getAttribute("idref") || "";
        const linear = itemref.getAttribute("linear") || "yes";
        const mi = manifest.get(idref);
        if (mi) {
          epub.spine.push({ href: mi.href, linear, index: i });
        }
      }
    }

    // EPUB2 cover fallback
    if (!epub.coverHref) {
      const metaNodes = opfDoc.getElementsByTagName("meta");
      for (let i = 0; i < metaNodes.length; i++) {
        if (metaNodes[i].getAttribute("name") === "cover") {
          const coverId = metaNodes[i].getAttribute("content");
          if (coverId) {
            const m = manifest.get(coverId);
            if (m) epub.coverHref = m.href;
          }
          break;
        }
      }
    }

    return epub;
  }

  /** Resolve an EPUB href (relative to OPF) to an absolute archive path. */
  resolve(href: string): string {
    if (!href) return "";
    if (href.includes("://")) return href;
    let resolved = href;
    if (this.opfDir) {
      resolved = resolveHref(this.opfDir, href);
    }
    return "/" + resolved;
  }

  /** Load an XHTML or XML file from the archive and parse it as a DOM Document. */
  async load(href: string): Promise<Document> {
    const resolved = this.resolve(href).replace(/^\/+/, "");
    const text = await this.readText(resolved);
    if (text === null) throw new Error(`File not found in EPUB: ${resolved}`);
    const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    return parseXml(clean, "application/xhtml+xml");
  }

  /** Get a binary file from the archive as a Blob. Path must start with "/". */
  async getBlob(archivePath: string): Promise<Blob | null> {
    const key = archivePath.replace(/^\/+/, "");
    const entry = this.findFile(key);
    if (!entry) return null;
    const uint8 = await this.zip.file(entry)?.async("uint8array");
    if (!uint8) return null;
    const ext = pathExt(key);
    const mimeType = MIME_BY_EXT[ext] || "";
    return new Blob([Buffer.from(uint8)], { type: mimeType });
  }

  /** Case-insensitive file lookup. Returns the actual zip entry name or null. */
  findFile(href: string): string | null {
    const clean = href.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!clean) return null;
    // Try exact match first
    if (this.zip.file(clean)) return clean;
    // Case-insensitive fallback
    return this.fileMap.get(clean.toLowerCase()) ?? null;
  }

  /** Read a text file from the archive. Returns null if not found. */
  private async readText(href: string): Promise<string | null> {
    const clean = href.replace(/^\/+/, "");
    const actual = this.findFile(clean);
    if (!actual) return null;
    const text = await this.zip.file(actual)?.async("string");
    return text ?? null;
  }

  destroy(): void {
    // ponytail: JSZip needs no explicit teardown.
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function parseXml(xml: string, mimeType = "application/xml"): Document {
  // @xmldom/xmldom Document is compatible at runtime but its TS shape
  // doesn't include browser-specific members like URL, alinkColor, etc.
  return new DOMParser().parseFromString(xml, mimeType) as unknown as Document;
}

function textOf(node: Element): string {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

function parseMetadata(opfDoc: Document): { title: string; creator: string } {
  const metadataNode = opfDoc.getElementsByTagName("metadata")[0];
  if (!metadataNode) return { title: "Untitled", creator: "" };
  const title = getElementText(metadataNode, "title");
  const creator = getElementText(metadataNode, "creator");
  return { title: title || "Untitled", creator };
}

function getElementText(xml: Element, tag: string): string {
  const found = xml.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", tag);
  if (!found || found.length === 0) return "";
  const el = found[0];
  return (el.textContent || "").trim();
}

// ---------------------------------------------------------------------------
// Inline HTML serialization
// ---------------------------------------------------------------------------

const INLINE_TAG_MAP: Record<string, string> = {
  em: "em",
  i: "em",
  strong: "strong",
  b: "strong",
  a: "a",
};

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineHtml(
  node: Node,
  linkResolver?: (href: string) => LinkTarget | null
): string {
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
    const elId = el.getAttribute("id");
    const idAttr = elId ? ` id="${escapeHtmlText(elId)}"` : "";
    const tag = INLINE_TAG_MAP[local];
    if (tag === "a" && linkResolver) {
      const href = el.getAttribute("href");
      const inner = inlineHtml(el, linkResolver);
      if (href && inner.trim()) {
        const target = linkResolver(href);
        if (target) {
          const frag = target.fragment ? ` data-fragment="${escapeHtmlText(target.fragment)}"` : "";
          out += `<a${idAttr} data-chapter="${target.chapterIndex}"${frag} href="${escapeHtmlText(href)}">${inner}</a>`;
          continue;
        }
      }
      if (elId && inner.trim()) {
        out += `<a${idAttr}>${inner}</a>`;
        continue;
      }
      out += inner;
      continue;
    }
    const inner = inlineHtml(el, linkResolver);
    out += tag && inner.trim() ? `<${tag}${idAttr}>${inner}</${tag}>` : inner;
  }
  return out;
}

function collapseInlineHtml(html: string): string {
  return html
    .split(/<br\s*\/?>/)
    .map((seg) => seg.replace(/\s+/g, " ").trim())
    .filter((seg) => seg.length > 0)
    .join("<br/>");
}

function makeBlock(
  type: ContentBlock["type"],
  node: Element,
  level?: number,
  linkResolver?: (href: string) => LinkTarget | null,
  fragment?: string
): ContentBlock | null {
  const text = textOf(node);
  if (!text) return null;
  const html = collapseInlineHtml(inlineHtml(node, linkResolver));
  const block: ContentBlock = { type, text };
  if (level !== undefined) block.level = level;
  if (html.includes("<")) block.html = html;
  const id = node.getAttribute("id") || fragment;
  if (id) block.fragment = id;
  return block;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

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

function stripFragment(href: string): string {
  const i = href.indexOf("#");
  return i >= 0 ? href.slice(0, i) : href;
}

function pathExt(href: string): string {
  const clean = stripFragment(href);
  const base = clean.split("/").pop() || clean;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Read {width, height} from an image file on disk. Handles PNG, JPEG, GIF,
 *  WebP, and BMP — the formats found in EPUBs. Returns null on any failure
 *  so callers silently fall back to no-dimension behaviour. */
function getImageDimensions(filePath: string): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(32);
    const bytesRead = fs.readSync(fd, header, 0, 32, 0);
    fs.closeSync(fd);
    if (bytesRead < 24) return null;

    // PNG: 89 50 4E 47 – IHDR at offset 16 gives width (4B BE) + height (4B BE)
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    }

    // GIF: 47 49 46 – width/height are little-endian uint16 at offsets 6,8
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
      return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
    }

    // BMP: 42 4D – width/height are signed int32 LE at offsets 18,22
    if (header[0] === 0x42 && header[1] === 0x4D) {
      const w = header.readInt32LE(18);
      const h = header.readInt32LE(22);
      return { width: Math.abs(w), height: Math.abs(h) };
    }

    // JPEG: FF D8 – scan for a SOF marker, width/height are uint16 BE inside it
    if (header[0] === 0xFF && header[1] === 0xD8) {
      // Read up to 64 KB to cover EXIF + header cruft before the SOF marker.
      const buf = fs.readFileSync(filePath, { flag: "r" });
      let pos = 2;
      while (pos < buf.length - 8) {
        if (buf[pos] !== 0xFF) return null;
        const marker = buf[pos + 1];
        // SOF markers: C0 C1 C2 C3 C9 CA CB
        if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC9 && marker <= 0xCB)) {
          return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
        }
        pos += 2 + buf.readUInt16BE(pos + 2);
      }
      return null;
    }

    // WebP: RIFF .... WEBP
    if (
      header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50
    ) {
      const buf = fs.readFileSync(filePath, { flag: "r" });
      // VP8  (lossy): 4 bytes "VP8 " at offset 12 → 10-byte chunk, w/h at +14,+16 masked to 14 bits
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
        return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
      }
      // VP8L (lossless): "VP8L" at 12 → 5-byte chunk, w+1/h+1 packed into 28 bits at +21
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4C) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
      }
      // VP8X (extended): "VP8X" at 12 → 8-byte chunk, 24-bit LE w/h at +24
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
        const w = buf.readUInt32LE(24) & 0x00FF_FFFF;
        const h = buf.readUInt32LE(27) & 0x00FF_FFFF;
        return { width: w + 1, height: h + 1 };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// Block extraction from XHTML body
// ---------------------------------------------------------------------------

function extractBlocks(
  doc: Document,
  imageMap?: Map<string, string>,
  docHref?: string,
  linkResolver?: (href: string) => LinkTarget | null
): ContentBlock[] {
  const body =
    doc.getElementsByTagName("body")[0] ||
    doc.documentElement.getElementsByTagName("body")[0];
  if (!body) return [];

  const blocks: ContentBlock[] = [];
  const skip = new Set(["script", "style", "head", "title", "meta", "link"]);

  function imageBlock(img: Element, fragment?: string): ContentBlock | null {
    if (!imageMap || !docHref) return null;
    const src = img.getAttribute("src");
    if (!src) return null;
    const resolved = resolveHref(docHref, src);
    const savedPath = imageMap.get(resolved);
    if (!savedPath) return null;
    const block: ContentBlock = {
      type: "image",
      text: (img.getAttribute("alt") || "").replace(/\s+/g, " ").trim(),
      src: savedPath,
    };
    const id = img.getAttribute("id") || fragment;
    if (id) block.fragment = id;
    return block;
  }

  function walk(el: Element, ancestorFragment?: string): void {
    const ownId = el.getAttribute("id") || undefined;
    const childFragment = ownId || ancestorFragment;

    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child.nodeType !== 1) continue;
      const node = child as Element;
      const local = node.localName || node.nodeName.toLowerCase();
      const nsLocal =
        local.indexOf(":") >= 0 ? local.split(":").slice(1).join(":") : local;

      if (skip.has(nsLocal)) continue;

      if (/^h[1-6]$/.test(nsLocal)) {
        const block = makeBlock("heading", node, +nsLocal[1], linkResolver, childFragment);
        if (block) blocks.push(block);
        continue;
      }

      if (nsLocal === "p" || nsLocal === "blockquote") {
        const imgs = node.getElementsByTagName("img");
        if (imgs.length > 0 && !textOf(node)) {
          const block = imageBlock(imgs[0], childFragment);
          if (block) blocks.push(block);
          continue;
        }
        const block = makeBlock("paragraph", node, undefined, linkResolver, childFragment);
        if (block) blocks.push(block);
        continue;
      }

      if (nsLocal === "img") {
        const block = imageBlock(node, childFragment);
        if (block) blocks.push(block);
        continue;
      }

      if (nsLocal === "figure") {
        const imgs = node.getElementsByTagName("img");
        const block = imgs.length > 0 ? imageBlock(imgs[0], childFragment) : null;
        if (block) blocks.push(block);
        continue;
      }

      if (nsLocal === "li") {
        const block = makeBlock("paragraph", node, undefined, linkResolver, childFragment);
        if (block) blocks.push(block);
        continue;
      }

      walk(node, childFragment);
    }
  }

  walk(body);
  return blocks;
}

// ---------------------------------------------------------------------------
// Link resolver for cross-chapter <a> links
// ---------------------------------------------------------------------------

function makeLinkResolver(
  docFullPath: string,
  spineToChapter: Map<string, number>,
  chapterIndex: number
): (href: string) => LinkTarget | null {
  return (href: string): LinkTarget | null => {
    if (href.startsWith("#")) return { chapterIndex, fragment: href.slice(1) };
    const [path, fragment] = href.split("#");
    const resolved = resolveHref(docFullPath, path || "");
    const ch = spineToChapter.get(resolved);
    if (ch === undefined) return null;
    return fragment ? { chapterIndex: ch, fragment } : { chapterIndex: ch };
  };
}

// ---------------------------------------------------------------------------
// Navigation / TOC parsing
// ---------------------------------------------------------------------------

/** Parse EPUB3 nav.xhtml's <nav epub:type="toc"> into a flat list. */
function parseNavXhtml(navEl: Element): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];

  function walkOl(ol: Element): void {
    const nodes = ol.childNodes;
    if (!nodes) return;
    for (let i = 0; i < nodes.length; i++) {
      const li = nodes[i] as Element;
      if (!li || li.nodeType !== 1) continue;
      if (li.localName !== "li" && li.tagName !== "li") continue;
      const a =
        li.getElementsByTagNameNS(XHTML_NS, "a")[0] ||
        li.getElementsByTagNameNS(XHTML_NS, "span")[0];
      if (a) {
        const href = a.getAttribute("href");
        const label = (a.textContent || "").replace(/\s+/g, " ").trim();
        if (href && label) out.push({ label, href });
      }
      const childOl = li.getElementsByTagNameNS(XHTML_NS, "ol")[0];
      if (childOl) walkOl(childOl);
    }
  }

  const topOl = navEl.getElementsByTagNameNS(XHTML_NS, "ol")[0];
  if (topOl) walkOl(topOl);
  return out;
}

/** Parse EPUB2 NCX document into a flat list of { label, href } entries. */
function parseNcx(doc: Document): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  const navPoints = doc.getElementsByTagName("navPoint");

  function walk(points: HTMLCollectionOf<Element>): void {
    for (let i = 0; i < points.length; i++) {
      const np = points[i];
      const content = np.getElementsByTagName("content")[0];
      const navLabel = np.getElementsByTagName("navLabel")[0];
      if (content && navLabel) {
        const src = content.getAttribute("src") || "";
        const label = (navLabel.textContent || "").replace(/\s+/g, " ").trim();
        if (src && label) out.push({ label, href: src });
      }
      // Recurse into nested navPoints
      const children = np.getElementsByTagName("navPoint");
      if (children.length > 0) walk(children);
    }
  }

  walk(navPoints);
  return out;
}

/** Load and parse the EPUB navigation (EPUB3 nav.xhtml preferred, EPUB2 NCX fallback). */
async function loadNav(epub: Epub): Promise<{ label: string; href: string }[]> {
  const opfDir = epub.opfDir;

  // EPUB3 nav.xhtml
  if (epub.navPath) {
    try {
      const doc = await epub.load(epub.navPath);
      const navEls = doc.getElementsByTagNameNS(XHTML_NS, "nav");
      for (let i = 0; i < navEls.length; i++) {
        const navEl = navEls[i];
        const epubType = navEl.getAttributeNS(
          "http://www.idpf.org/2007/ops",
          "type"
        );
        if (!epubType || !epubType.split(/\s+/).includes("toc")) continue;
        const entries = parseNavXhtml(navEl);
        if (entries.length > 0) {
          const navDir = epub.navPath.includes("/")
            ? epub.navPath.substring(0, epub.navPath.lastIndexOf("/") + 1)
            : "";
          return entries.map((e) => ({
            label: e.label,
            href: navDir + e.href,
          }));
        }
      }
    } catch {
      // ponytail: fall through to NCX
    }
  }

  // EPUB2 NCX
  if (epub.ncxPath) {
    try {
      const doc = await epub.load(epub.ncxPath);
      const items = parseNcx(doc);
      if (items.length > 0) return items;
    } catch {
      // ponytail: fall through
    }
  }

  console.warn("[epub] nav parse failed for both nav.xhtml and NCX; falling back to spine walk");
  return [];
}

// ---------------------------------------------------------------------------
// Chapter title fallback
// ---------------------------------------------------------------------------

function chapterTitle(doc: Document, fallback: string): string {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Pull cover image bytes out of an already-opened Epub. */
async function coverOf(epub: Epub): Promise<EpubCover | null> {
  const coverHref = epub.coverHref;
  if (!coverHref) return null;
  try {
    const blob = await epub.getBlob(epub.resolve(coverHref));
    if (!blob) return null;
    const data = Buffer.from(await blob.arrayBuffer());
    if (data.length === 0) return null;
    return { data, ext: extFromCover(coverHref, blob.type) };
  } catch {
    return null;
  }
}

/**
 * Lightweight import-time read: title, author, cover. Skips chapter parsing.
 */
export async function readEpubMeta(filePath: string): Promise<EpubMeta> {
  const epub = await Epub.open(filePath);
  try {
    const { title, creator: author } = epub.metadata;
    const cover = await coverOf(epub);
    return { title, author, cover };
  } finally {
    epub.destroy();
  }
}

/**
 * Parse an EPUB file from disk into structured chapters.
 *
 * @param filePath absolute path to a .epub
 * @param bookId database id, used as the image storage key
 */
export async function parseEpub(
  filePath: string,
  bookId?: number
): Promise<ParsedEpub> {
  const epub = await Epub.open(filePath);
  try {
    const { title, creator: author } = epub.metadata;

    // Parse the navigation (TOC) to get chapter boundaries.
    const flatNav = await loadNav(epub);

    // Build spine index for nav→spine lookups and link resolution.
    interface SpineRef {
      index: number;
      href: string;
    }
    const spineItems: SpineRef[] = [];
    const spineByHref = new Map<string, SpineRef>();
    let spineIdx = 0;
    for (let i = 0; i < epub.spine.length; i++) {
      const s = epub.spine[i];
      if (s.linear === "no") continue;
      const ref: SpineRef = { index: spineIdx++, href: s.href };
      spineItems.push(ref);
      const base = stripFragment(s.href);
      if (!spineByHref.has(base)) spineByHref.set(base, ref);
    }

    // Image extraction setup
    const imageMap = new Map<string, string>();
    const imageDir =
      bookId !== undefined
        ? path.join(getCoversDir(), String(bookId), "images")
        : null;
    if (imageDir) fs.mkdirSync(imageDir, { recursive: true });

    /** Extract image blob from archive (href is already resolved relative to the XHTML doc). */
    function getImageBlob(href: string): Promise<Blob | null> {
      return epub.getBlob("/" + href);
    }

    const spineToChapter = new Map<string, number>();
    const chapters: ParsedChapter[] = [];
    let coveredUpTo = 0;

    if (flatNav.length > 0) {
      for (let i = 0; i < flatNav.length; i++) {
        const entry = flatNav[i];
        const startHref = stripFragment(entry.href);
        const startItem = spineByHref.get(startHref);
        if (!startItem) continue;
        if (startItem.index < coveredUpTo) continue;

        let nextStartIndex = spineItems.length;
        for (let j = i + 1; j < flatNav.length; j++) {
          const nextHref = stripFragment(flatNav[j].href);
          const nextItem = spineByHref.get(nextHref);
          if (nextItem && nextItem.index > startItem.index) {
            nextStartIndex = nextItem.index;
            break;
          }
        }

        // Register spine→chapter mappings for cross-spine-item links
        for (const item of spineItems) {
          if (item.index < startItem.index) continue;
          if (item.index >= nextStartIndex) break;
          const spineHref = epub.resolve(item.href).replace(/^\/+/, "");
          spineToChapter.set(stripFragment(spineHref), chapters.length);
        }

        // Extract blocks
        const allBlocks: ContentBlock[] = [];
        for (const item of spineItems) {
          if (item.index < startItem.index) continue;
          if (item.index >= nextStartIndex) break;
          let doc: Document;
          try {
            doc = await epub.load(item.href);
          } catch {
            continue;
          }

          const docFullPath = epub.resolve(item.href).replace(/^\/+/, "");

          // Extract images from this spine doc
          if (imageDir) {
            const imgs = doc.getElementsByTagName("img");
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
                  imageMap.set(resolved, `covers/${bookId}/images/${filename}`);
                }
              } catch {
                // skip unreadable images
              }
            }
          }

          const resolveLink = makeLinkResolver(docFullPath, spineToChapter, chapters.length);
          const blocks = extractBlocks(doc, imageMap, docFullPath, resolveLink);
          allBlocks.push(...blocks);
        }

        if (allBlocks.length === 0) continue;

        // Attach image dimensions so the renderer can reserve space before load.
        if (imageDir) {
          const imgDims = new Map<string, { width: number; height: number }>();
          for (const [, savedPath] of imageMap) {
            const dims = getImageDimensions(path.join(imageDir, path.basename(savedPath)));
            if (dims) imgDims.set(savedPath, dims);
          }
          for (const b of allBlocks) {
            if (b.type === "image" && b.src) {
              const dims = imgDims.get(b.src);
              if (dims) { b.imgWidth = dims.width; b.imgHeight = dims.height; }
            }
          }
        }

        chapters.push({
          index: chapters.length,
          title: entry.label,
          rawText: JSON.stringify(allBlocks),
        });
        coveredUpTo = Math.max(coveredUpTo, nextStartIndex);
      }
    } else {
      // Nav-less fallback: iterate spine items
      for (let i = 0; i < spineItems.length; i++) {
        const item = spineItems[i];
        let doc: Document;
        try {
          doc = await epub.load(item.href);
        } catch {
          continue;
        }

        const spineHref = epub.resolve(item.href).replace(/^\/+/, "");
        spineToChapter.set(stripFragment(spineHref), chapters.length);

        const docFullPath = epub.resolve(item.href).replace(/^\/+/, "");
        if (imageDir) {
          const imgs = doc.getElementsByTagName("img");
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
                imageMap.set(resolved, `covers/${bookId}/images/${filename}`);
              }
            } catch {
              // skip unreadable images
            }
          }
        }

        const resolveLink = makeLinkResolver(docFullPath, spineToChapter, chapters.length);
        const blocks = extractBlocks(doc, imageMap, docFullPath, resolveLink);
        if (blocks.length === 0) continue;

        // Attach image dimensions so the renderer can reserve space before load.
        if (imageDir) {
          const imgDims = new Map<string, { width: number; height: number }>();
          for (const [, savedPath] of imageMap) {
            const dims = getImageDimensions(path.join(imageDir, path.basename(savedPath)));
            if (dims) imgDims.set(savedPath, dims);
          }
          for (const b of blocks) {
            if (b.type === "image" && b.src) {
              const dims = imgDims.get(b.src);
              if (dims) { b.imgWidth = dims.width; b.imgHeight = dims.height; }
            }
          }
        }

        chapters.push({
          index: chapters.length,
          title: chapterTitle(doc, `Chapter ${chapters.length + 1}`),
          rawText: JSON.stringify(blocks),
        });
      }
    }

    return { title, author, chapters };
  } finally {
    epub.destroy();
  }
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

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
