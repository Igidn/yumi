import fs from "fs";
import path from "path";
import type { ParsedEpub, EpubCover, EpubMeta, ContentBlock } from "./types";
import { MAX_EXTRACTED_IMAGES, MAX_IMAGE_SIZE_BYTES } from "./types";
import { Epub } from "./epub-class";
import { loadNav } from "./nav";
import { extractBlocks, makeLinkResolver } from "./blocks";
import {
  resolveHref,
  stripFragment,
  pathExt,
  getImageDimensions,
  extFromCover,
  chapterTitle,
} from "./util";
import { getCoversDir } from "../paths";

// ---------------------------------------------------------------------------
// Cover extraction
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

    const spineToChapter = new Map<string, number>();
    const chapters: ParsedEpub["chapters"] = [];
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
        const allBlocks = await extractBlocksForRange(
          epub, spineItems, startItem.index, nextStartIndex,
          imageDir, imageMap, spineToChapter, chapters.length
        );

        if (allBlocks.length === 0) continue;

        // Attach image dimensions so the renderer can reserve space before load.
        attachImageDims(allBlocks, imageMap, imageDir);

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
        let doc;
        try {
          doc = await epub.load(item.href);
        } catch {
          continue;
        }

        const spineHref = epub.resolve(item.href).replace(/^\/+/, "");
        spineToChapter.set(stripFragment(spineHref), chapters.length);

        const docFullPath = epub.resolve(item.href).replace(/^\/+/, "");
        await extractImages(epub, doc, docFullPath, imageDir, imageMap);

        const resolveLink = makeLinkResolver(docFullPath, spineToChapter, chapters.length);
        const blocks = extractBlocks(doc, imageMap, docFullPath, resolveLink);
        if (blocks.length === 0) continue;

        attachImageDims(blocks, imageMap, imageDir);

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
// Internal helpers
// ---------------------------------------------------------------------------

async function extractImages(
  epub: Epub,
  doc: Document,
  docFullPath: string,
  imageDir: string | null,
  imageMap: Map<string, string>,
): Promise<void> {
  if (!imageDir) return;

  const imgs = doc.getElementsByTagName("img");
  for (let j = 0; j < imgs.length; j++) {
    const src = imgs[j].getAttribute("src");
    if (!src) continue;
    const resolved = resolveHref(docFullPath, src);
    if (imageMap.has(resolved)) continue;
    if (imageMap.size >= MAX_EXTRACTED_IMAGES) break;
    try {
      const blob = await epub.getBlob("/" + resolved);
      if (blob && blob.size > 0 && blob.size <= MAX_IMAGE_SIZE_BYTES) {
        const ext = pathExt(resolved) || "jpg";
        const filename = `${imageMap.size}.${ext}`;
        const dest = path.join(imageDir, filename);
        await fs.promises.writeFile(dest, Buffer.from(await blob.arrayBuffer()));
        // bookId is derivable from imageDir: covers/<bookId>/images
        const bookId = path.basename(path.dirname(imageDir));
        imageMap.set(resolved, `covers/${bookId}/images/${filename}`);
      }
    } catch {
      // skip unreadable images
    }
  }
}

async function extractBlocksForRange(
  epub: Epub,
  spineItems: Array<{ index: number; href: string }>,
  startIndex: number,
  endIndex: number,
  imageDir: string | null,
  imageMap: Map<string, string>,
  spineToChapter: Map<string, number>,
  chapterIndex: number,
): Promise<ContentBlock[]> {
  const allBlocks: ContentBlock[] = [];

  for (const item of spineItems) {
    if (item.index < startIndex) continue;
    if (item.index >= endIndex) break;
    let doc: Document;
    try {
      doc = await epub.load(item.href);
    } catch {
      continue;
    }

    const docFullPath = epub.resolve(item.href).replace(/^\/+/, "");

    await extractImages(epub, doc, docFullPath, imageDir, imageMap);

    const resolveLink = makeLinkResolver(docFullPath, spineToChapter, chapterIndex);
    const blocks = extractBlocks(doc, imageMap, docFullPath, resolveLink);
    allBlocks.push(...blocks);
  }

  return allBlocks;
}

function attachImageDims(
  blocks: ContentBlock[],
  imageMap: Map<string, string>,
  imageDir: string | null,
): void {
  if (!imageDir) return;
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
