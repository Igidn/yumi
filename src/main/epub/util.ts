import { DOMParser } from "@xmldom/xmldom";
import fs from "fs";

export function parseXml(xml: string, mimeType = "application/xml"): Document {
  return new DOMParser().parseFromString(xml, mimeType) as unknown as Document;
}

export function textOf(node: Element): string {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

export function parseMetadata(opfDoc: Document): {
  title: string;
  creator: string;
} {
  const metadataNode = opfDoc.getElementsByTagName("metadata")[0];
  if (!metadataNode) return { title: "Untitled", creator: "" };
  const title = getElementText(metadataNode, "title");
  const creator = getElementText(metadataNode, "creator");
  return { title: title || "Untitled", creator };
}

function getElementText(xml: Element, tag: string): string {
  const found = xml.getElementsByTagNameNS(
    "http://purl.org/dc/elements/1.1/",
    tag,
  );
  if (!found || found.length === 0) return "";
  const el = found[0];
  return (el.textContent || "").trim();
}

export function resolveHref(base: string, rel: string): string {
  const baseDir = base.includes("/")
    ? base.substring(0, base.lastIndexOf("/") + 1)
    : "";
  const parts = (baseDir + rel).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }
  return resolved.join("/");
}

export function stripFragment(href: string): string {
  const i = href.indexOf("#");
  return i >= 0 ? href.slice(0, i) : href;
}

export function pathExt(href: string): string {
  const clean = stripFragment(href);
  const base = clean.split("/").pop() || clean;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Read {width, height} from an image file on disk. Handles PNG, JPEG, GIF,
 *  WebP, and BMP — the formats found in EPUBs. Returns null on any failure
 *  so callers silently fall back to no-dimension behaviour. */
export function getImageDimensions(
  filePath: string,
): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(32);
    const bytesRead = fs.readSync(fd, header, 0, 32, 0);
    fs.closeSync(fd);
    if (bytesRead < 24) return null;

    // PNG: 89 50 4E 47 – IHDR at offset 16 gives width (4B BE) + height (4B BE)
    if (
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47
    ) {
      return {
        width: header.readUInt32BE(16),
        height: header.readUInt32BE(20),
      };
    }

    // GIF: 47 49 46 – width/height are little-endian uint16 at offsets 6,8
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
      return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
    }

    // BMP: 42 4D – width/height are signed int32 LE at offsets 18,22
    if (header[0] === 0x42 && header[1] === 0x4d) {
      const w = header.readInt32LE(18);
      const h = header.readInt32LE(22);
      return { width: Math.abs(w), height: Math.abs(h) };
    }

    // JPEG: FF D8 – scan for a SOF marker, width/height are uint16 BE inside it
    if (header[0] === 0xff && header[1] === 0xd8) {
      const buf = fs.readFileSync(filePath, { flag: "r" });
      let pos = 2;
      while (pos < buf.length - 8) {
        if (buf[pos] !== 0xff) return null;
        const marker = buf[pos + 1];
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc9 && marker <= 0xcb)
        ) {
          return {
            width: buf.readUInt16BE(pos + 7),
            height: buf.readUInt16BE(pos + 5),
          };
        }
        pos += 2 + buf.readUInt16BE(pos + 2);
      }
      return null;
    }

    // WebP: RIFF .... WEBP
    if (
      header[0] === 0x52 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x46 &&
      header[8] === 0x57 &&
      header[9] === 0x45 &&
      header[10] === 0x42 &&
      header[11] === 0x50
    ) {
      const buf = fs.readFileSync(filePath, { flag: "r" });
      if (
        buf[12] === 0x56 &&
        buf[13] === 0x50 &&
        buf[14] === 0x38 &&
        buf[15] === 0x20
      ) {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      if (
        buf[12] === 0x56 &&
        buf[13] === 0x50 &&
        buf[14] === 0x38 &&
        buf[15] === 0x4c
      ) {
        const bits = buf.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      if (
        buf[12] === 0x56 &&
        buf[13] === 0x50 &&
        buf[14] === 0x38 &&
        buf[15] === 0x58
      ) {
        const w = buf.readUInt32LE(24) & 0x00ff_ffff;
        const h = buf.readUInt32LE(27) & 0x00ff_ffff;
        return { width: w + 1, height: h + 1 };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

export function extFromCover(
  coverHref: string,
  mime: string | undefined,
): string {
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

export function chapterTitle(doc: Document, fallback: string): string {
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
