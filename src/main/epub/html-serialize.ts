import type { ContentBlock, LinkTarget } from "./types";
import { textOf } from "./util";

const INLINE_TAG_MAP: Record<string, string> = {
  em: "em",
  i: "em",
  strong: "strong",
  b: "strong",
  a: "a",
  span: "span",
  sup: "sup",
  sub: "sub",
};

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlineHtml(
  node: Node,
  linkResolver?: (href: string) => LinkTarget | null,
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

    // <span> with inline style or CSS class hints — convert to <em>/<strong>
    if (tag === "span") {
      const style = (el.getAttribute("style") || "").toLowerCase();
      const cls = (el.getAttribute("class") || "").toLowerCase();
      const inner = inlineHtml(el, linkResolver);
      if (!inner.trim()) return out;
      if (/font-style\s*:\s*italic/.test(style) || cls.includes("italic")) {
        out += `<em${idAttr}>${inner}</em>`;
      } else if (/font-weight\s*:\s*bold/.test(style) || cls.includes("bold")) {
        out += `<strong${idAttr}>${inner}</strong>`;
      } else {
        out += inner;
      }
      continue;
    }

    if (tag === "a") {
      const href = el.getAttribute("href");
      const epubType = el.getAttribute("epub:type") || "";
      const isNoteref = epubType === "noteref";
      const inner = inlineHtml(el, linkResolver);
      if (href && inner.trim() && linkResolver) {
        const target = linkResolver(href);
        if (target) {
          const frag = target.fragment
            ? ` data-fragment="${escapeHtmlText(target.fragment)}"`
            : "";
          const a = `<a${idAttr} data-chapter="${target.chapterIndex}"${frag} href="${escapeHtmlText(href)}">${inner}</a>`;
          out += isNoteref ? `<sup class="noteref">${a}</sup>` : a;
          continue;
        }
      }
      if (elId && inner.trim()) {
        const a = `<a${idAttr}>${inner}</a>`;
        out += isNoteref ? `<sup class="noteref">${a}</sup>` : a;
        continue;
      }
      out += isNoteref ? `<sup class="noteref">${inner}</sup>` : inner;
      continue;
    }
    const inner = inlineHtml(el, linkResolver);
    out += tag && inner.trim() ? `<${tag}${idAttr}>${inner}</${tag}>` : inner;
  }
  return out;
}

export function collapseInlineHtml(html: string): string {
  return html
    .split(/<br\s*\/?>/)
    .map((seg) => seg.replace(/\s+/g, " ").trim())
    .filter((seg) => seg.length > 0)
    .join("<br/>");
}

export function makeBlock(
  type: ContentBlock["type"],
  node: Element,
  level?: number,
  linkResolver?: (href: string) => LinkTarget | null,
  fragment?: string,
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
