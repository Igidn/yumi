import { makeBlock } from "./html-serialize";
import type { ContentBlock, LinkTarget } from "./types";
import { resolveHref, textOf } from "./util";

export function extractBlocks(
  doc: Document,
  imageMap?: Map<string, string>,
  docHref?: string,
  linkResolver?: (href: string) => LinkTarget | null,
): ContentBlock[] {
  const body =
    doc.getElementsByTagName("body")[0] ||
    doc.documentElement.getElementsByTagName("body")[0];
  if (!body) return [];

  const blocks: ContentBlock[] = [];
  const skip = new Set(["script", "style", "head", "title", "meta", "link"]);

  // Inline <img> inside paragraphs: map source path → served asset URL.
  const imageResolver =
    imageMap && docHref
      ? (src: string): string | null => {
          const saved = imageMap.get(resolveHref(docHref, src));
          return saved ? `yumi://asset/${saved}` : null;
        }
      : undefined;

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
        const block = makeBlock(
          "heading",
          node,
          +nsLocal[1],
          linkResolver,
          childFragment,
          imageResolver,
        );
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
        const block = makeBlock(
          "paragraph",
          node,
          undefined,
          linkResolver,
          childFragment,
          imageResolver,
        );
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
        const block =
          imgs.length > 0 ? imageBlock(imgs[0], childFragment) : null;
        if (block) blocks.push(block);
        continue;
      }

      if (nsLocal === "li") {
        const block = makeBlock(
          "paragraph",
          node,
          undefined,
          linkResolver,
          childFragment,
          imageResolver,
        );
        if (block) blocks.push(block);
        continue;
      }

      walk(node, childFragment);
    }
  }

  walk(body);
  return blocks;
}

export function makeLinkResolver(
  docFullPath: string,
  spineToChapter: Map<string, number>,
  chapterIndex: number,
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
