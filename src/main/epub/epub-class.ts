import fs from "fs";
import JSZip from "jszip";

import { parseMetadata, parseXml, pathExt,resolveHref } from "./util";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp",
};

export class Epub {
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
