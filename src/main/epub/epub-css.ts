import fs from "fs";
import path from "path";

import { Epub } from "./epub-class";
import { resolveHref, stripFragment } from "./util";

/**
 * Book stylesheet extraction. Linked sheets and <style> blocks are written
 * under <bookId>/css/ mirroring their zip paths, so relative url() and
 * @import references resolve exactly as they did inside the archive —
 * referenced fonts/images are extracted alongside. Every rule is scoped
 * with `.book-css` so the book's CSS can't leak into the reader chrome.
 */

const SCOPE_CLASS = ".book-css";

const IMPORT_RE =
  /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*[;]/gi;
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

export interface CssState {
  sheets: Set<string>;
  assets: Set<string>;
  /** Relative paths (zip-mirrored) in cascade order. */
  order: string[];
}

export function newCssState(): CssState {
  return { sheets: new Set(), assets: new Set(), order: [] };
}

/** Prefix every selector with the scope class, preserving at-rules. */
export function scopeCss(css: string): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const chunk = css.slice(i, end === -1 ? n : end + 2);
      out += chunk;
      i += chunk.length;
      continue;
    }
    // Semicolon-terminated at-rules: copy verbatim, `;`-aware. atName is
    // read from the trimmed slice — a leading newline would break the ^@.
    const atName = /^@([a-zA-Z-]+)/.exec(css.slice(i).trimStart())?.[1];
    if (atName === "import" || atName === "charset" || atName === "namespace") {
      const end = indexOfChar(css, i, ";");
      const chunk = css.slice(i, end === -1 ? n : end + 1);
      out += chunk;
      i += chunk.length;
      continue;
    }
    const open = indexOfChar(css, i, "{");
    if (open === -1) {
      out += css.slice(i);
      break;
    }
    const prelude = css.slice(i, open).trim();
    const close = matchBrace(css, open);
    if (close === -1) {
      out += css.slice(i);
      break;
    }
    const body = css.slice(open + 1, close);
    if (
      atName === "media" ||
      atName === "supports" ||
      atName === "container" ||
      atName === "layer"
    ) {
      out += `${prelude}{${scopeCss(body)}}`;
    } else if (
      atName === "font-face" ||
      atName === "keyframes" ||
      atName === "page" ||
      (atName ?? "").endsWith("keyframes")
    ) {
      out += `${prelude}{${body}}`;
    } else {
      out += `${scopeSelectors(prelude)}{${body}}`;
    }
    i = close + 1;
  }
  return out;
}

/** Find `needle` skipping strings and comments. */
function indexOfChar(s: string, from: number, needle: string): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < s.length) {
        if (s[i] === "\\") i++;
        else if (s[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === needle) return i;
  }
  return -1;
}

/** Index of the `}` matching the `{` at `open`, string/comment aware. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < s.length) {
        if (s[i] === "\\") i++;
        else if (s[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a selector list on top-level commas (paren/bracket aware). */
function splitSelectors(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

function scopeSelectors(prelude: string): string {
  return splitSelectors(prelude)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${SCOPE_CLASS} ${s}`)
    .join(", ");
}

/** Extract url()-referenced assets to their zip-mirrored paths. `base` is
 *  the zip path of the file the CSS came from. */
async function extractAssets(
  epub: Epub,
  css: string,
  base: string,
  cssRoot: string,
  state: CssState,
): Promise<void> {
  for (const m of css.matchAll(URL_RE)) {
    const raw = (m[2] || "").trim();
    if (!raw || /^(data:|https?:|#|\/\/)/i.test(raw)) continue;
    const target = stripFragment(resolveHref(base, raw));
    if (!target || state.assets.has(target)) continue;
    state.assets.add(target);
    const blob = await epub.getBlob("/" + target);
    if (!blob || blob.size === 0) continue;
    const dest = path.join(cssRoot, target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, Buffer.from(await blob.arrayBuffer()));
  }
}

/** Collect one linked sheet (and its @import chain) into the css tree.
 *  `href` is relative to the zip path of the referring file, `base`. */
async function collectSheet(
  epub: Epub,
  href: string,
  base: string,
  cssRoot: string,
  state: CssState,
): Promise<void> {
  const abs = stripFragment(resolveHref(base, href));
  if (!abs || state.sheets.has(abs)) return;
  const blob = await epub.getBlob("/" + abs);
  if (!blob) return;
  state.sheets.add(abs);
  state.order.push(abs);
  const text = await blob.text();
  for (const m of text.matchAll(IMPORT_RE)) {
    const target = m[2] ?? m[4];
    if (target) {
      await collectSheet(epub, target, abs, cssRoot, state);
    }
  }
  await extractAssets(epub, text, abs, cssRoot, state);
  const dest = path.join(cssRoot, abs);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, scopeCss(text));
}

/** Walk one chapter document for stylesheets and pull them out.
 *  `docFullPath` is the chapter's zip path; relative hrefs resolve from it. */
export async function extractBookStylesheets(
  epub: Epub,
  doc: Document,
  docFullPath: string,
  cssRoot: string,
  state: CssState,
): Promise<void> {
  const styles = doc.getElementsByTagName("style");
  let inline = "";
  for (let i = 0; i < styles.length; i++) inline += styles[i].textContent || "";
  if (inline.trim()) {
    const rel = docFullPath + ".inline.css";
    if (!state.sheets.has(rel)) {
      state.sheets.add(rel);
      state.order.push(rel);
      for (const m of inline.matchAll(IMPORT_RE)) {
        const target = m[2] ?? m[4];
        if (target) {
          await collectSheet(epub, target, docFullPath, cssRoot, state);
        }
      }
      await extractAssets(epub, inline, docFullPath, cssRoot, state);
      const dest = path.join(cssRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, scopeCss(inline));
    }
  }

  const links = doc.getElementsByTagName("link");
  for (let i = 0; i < links.length; i++) {
    const rel = (links[i].getAttribute("rel") || "").split(/\s+/);
    const href = links[i].getAttribute("href");
    if (href && rel.includes("stylesheet")) {
      await collectSheet(epub, href, docFullPath, cssRoot, state);
    }
  }
}
