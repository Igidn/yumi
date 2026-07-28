import type { Epub } from "./epub-class";
import { XHTML_NS } from "./types";
import { resolveHref } from "./util";

/** Parse EPUB3 nav.xhtml's <nav epub:type="toc"> into a flat list. */
export function parseNavXhtml(
  navEl: Element,
): { label: string; href: string }[] {
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
export function parseNcx(doc: Document): { label: string; href: string }[] {
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
      const children = np.getElementsByTagName("navPoint");
      if (children.length > 0) walk(children);
    }
  }

  walk(navPoints);
  return out;
}

/** Load and parse the EPUB navigation (EPUB3 nav.xhtml preferred, EPUB2 NCX fallback). */
export async function loadNav(
  epub: Epub,
): Promise<{ label: string; href: string }[]> {
  // EPUB3 nav.xhtml
  if (epub.navPath) {
    try {
      const doc = await epub.load(epub.navPath);
      const navEls = doc.getElementsByTagNameNS(XHTML_NS, "nav");
      for (let i = 0; i < navEls.length; i++) {
        const navEl = navEls[i];
        const epubType = navEl.getAttributeNS(
          "http://www.idpf.org/2007/ops",
          "type",
        );
        if (!epubType || !epubType.split(/\s+/).includes("toc")) continue;
        const entries = parseNavXhtml(navEl);
        if (entries.length > 0) {
          const navDir = epub.navPath.includes("/")
            ? epub.navPath.substring(0, epub.navPath.lastIndexOf("/") + 1)
            : "";
          return entries.map((e) => ({
            label: e.label,
            href: resolveHref(navDir, e.href),
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
      if (items.length > 0) {
        const ncxDir = epub.ncxPath.includes("/")
          ? epub.ncxPath.substring(0, epub.ncxPath.lastIndexOf("/") + 1)
          : "";
        return items.map((e) => ({
          label: e.label,
          href: resolveHref(ncxDir, e.href),
        }));
      }
    } catch {
      // ponytail: fall through
    }
  }

  console.warn(
    "[epub] nav parse failed for both nav.xhtml and NCX; falling back to spine walk",
  );
  return [];
}
