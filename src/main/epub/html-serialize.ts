import type { ContentBlock, LinkTarget } from "./types";
import { textOf } from "./util";

/** Tags that must never survive serialization. */
const DROP_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "object",
  "embed",
  "iframe",
  "video",
  "audio",
  "canvas",
  "svg",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "noscript",
  "template",
]);

/** Attribute names kept verbatim (values escaped); everything else — event
 *  handlers included — is dropped. */
const KEEP_ATTRS = ["id", "class", "style", "title", "lang", "dir", "xml:lang"];

/** href schemes the renderer is allowed to keep on unresolved links. */
const SAFE_HREF = /^(https?:|mailto:)/i;

export function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Serialize a kept attribute list for an element, escaping values. */
function safeAttrs(el: Element): string {
  let out = "";
  for (const name of KEEP_ATTRS) {
    const v = el.getAttribute(name);
    if (v != null && v !== "") out += ` ${name}="${escapeHtmlText(v)}"`;
  }
  return out;
}

/** <img> inside text: src rewritten to a served asset, dims kept. */
function imgHtml(
  el: Element,
  imageResolver?: (src: string) => string | null,
): string {
  const src = el.getAttribute("src");
  const mapped = src && imageResolver ? imageResolver(src) : null;
  if (!mapped) return "";
  let out = `<img src="${escapeHtmlText(mapped)}"`;
  const alt = el.getAttribute("alt");
  if (alt != null) {
    out += ` alt="${escapeHtmlText(alt.replace(/\s+/g, " ").trim())}"`;
  }
  for (const name of ["width", "height"]) {
    const v = el.getAttribute(name);
    if (v && /^\d+$/.test(v)) out += ` ${name}="${v}"`;
  }
  return out + safeAttrs(el) + "/>";
}

export function inlineHtml(
  node: Node,
  linkResolver?: (href: string) => LinkTarget | null,
  imageResolver?: (src: string) => string | null,
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
    if (DROP_TAGS.has(local)) continue;
    if (local === "br") {
      out += "<br/>";
      continue;
    }
    if (local === "img") {
      out += imgHtml(el, imageResolver);
      continue;
    }

    if (local === "a") {
      const href = el.getAttribute("href") || "";
      const epubType = el.getAttribute("epub:type") || "";
      const isNoteref = epubType === "noteref";
      const inner = inlineHtml(el, linkResolver, imageResolver);
      if (href && inner.trim() && linkResolver) {
        const target = linkResolver(href);
        if (target) {
          const frag = target.fragment
            ? ` data-fragment="${escapeHtmlText(target.fragment)}"`
            : "";
          const a = `<a${safeAttrs(el)} data-chapter="${target.chapterIndex}"${frag} href="${escapeHtmlText(href)}">${inner}</a>`;
          out += isNoteref ? `<sup class="noteref">${a}</sup>` : a;
          continue;
        }
      }
      if (href && SAFE_HREF.test(href) && inner.trim()) {
        const a = `<a${safeAttrs(el)} href="${escapeHtmlText(href)}">${inner}</a>`;
        out += isNoteref ? `<sup class="noteref">${a}</sup>` : a;
        continue;
      }
      if (el.getAttribute("id") && inner.trim()) {
        const a = `<a${safeAttrs(el)}>${inner}</a>`;
        out += isNoteref ? `<sup class="noteref">${a}</sup>` : a;
        continue;
      }
      out += isNoteref ? `<sup class="noteref">${inner}</sup>` : inner;
      continue;
    }

    const inner = inlineHtml(el, linkResolver, imageResolver);
    out += inner.trim()
      ? `<${local}${safeAttrs(el)}>${inner}</${local}>`
      : inner;
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
  imageResolver?: (src: string) => string | null,
): ContentBlock | null {
  const text = textOf(node);
  if (!text) return null;
  const html = collapseInlineHtml(
    inlineHtml(node, linkResolver, imageResolver),
  );
  const block: ContentBlock = { type, text };
  if (level !== undefined) block.level = level;
  if (html.includes("<")) block.html = html;
  const cls = node.getAttribute("class");
  if (cls) block.className = cls;
  const style = node.getAttribute("style");
  if (style) block.style = style;
  const id = node.getAttribute("id") || fragment;
  if (id) block.fragment = id;
  return block;
}
