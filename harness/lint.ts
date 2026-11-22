// Static scan of a piece: security (network APIs, eval, URL literals, external refs), CSP,
// size budget, constraint-night limits and the config/slop.yml static rules.
// Violation rules are `<category>/<id>`, so `{rule, detail}` drops into gates.slop_lint.violations.
import type { LintOptions, LintResult, SlopRule, SlopViolation } from "./types.js";

export const CANONICAL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:";

const CSP_META_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;

// Namespace URIs are identifiers, never fetched; JS-built SVG needs them.
const ALLOWED_URLS = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/2000/xmlns/",
]);

// ---------- JS tokenizing ----------

export interface JsScan {
  /** Source with comments removed. */
  code: string;
  /** Same length as `code`, string-literal contents blanked to spaces (template `${}` kept). */
  noStr: string;
  /** Raw contents of every string and template literal. */
  strings: string[];
}

const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/;

/** Comment stripper aware of strings, templates and regex literals, so `"//"` never starts a comment. */
export function scanJs(src: string): JsScan {
  let code = "";
  let noStr = "";
  const strings: string[] = [];
  const emit = (s: string, blank = false): void => {
    code += s;
    noStr += blank ? s.replace(/[^\n]/g, " ") : s;
  };
  let i = 0;
  let last = "";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? src.length : e;
      continue;
    }
    if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      emit(" ");
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === "\\") {
      emit(src.slice(i, i + 2));
      i += 2;
      last = "\\";
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      j = Math.min(j, src.length);
      const body = src.slice(i + 1, j);
      strings.push(body);
      emit(c);
      emit(body, true);
      if (src[j] === c) {
        emit(c);
        j++;
      }
      i = j;
      last = c;
      continue;
    }
    if (c === "`") {
      emit("`");
      let j = i + 1;
      let body = "";
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") {
          const esc = src.slice(j, j + 2);
          emit(esc, true);
          body += esc;
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          while (k < src.length && depth) {
            if (src[k] === "{") depth++;
            else if (src[k] === "}") depth--;
            k++;
          }
          const inner = src.slice(j, k);
          emit(inner); // interpolations are code: keep them visible to the API scan
          body += inner;
          j = k;
          continue;
        }
        emit(src[j]!, true);
        body += src[j];
        j++;
      }
      strings.push(body);
      if (j < src.length) {
        emit("`");
        j++;
      }
      i = j;
      last = "`";
      continue;
    }
    if (c === "/" && (last === "" || REGEX_PRECEDERS.has(last) || REGEX_KEYWORDS.test(code.slice(-16).trimEnd()))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n") {
        const ch = src[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "[") cls = true;
        else if (ch === "]") cls = false;
        else if (ch === "/" && !cls) break;
        j++;
      }
      if (src[j] === "/") {
        emit(src.slice(i, j + 1));
        i = j + 1;
        last = "/";
        continue;
      }
    }
    emit(c);
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return { code, noStr, strings };
}

// ---------- HTML segmentation ----------

export interface ParsedPiece {
  /** HTML outside script/style bodies, comments removed, script/style opening tags kept. */
  markup: string;
  scripts: Array<{ attrs: string; scan: JsScan }>;
  /** Style bodies with CSS comments removed. */
  styles: string[];
  /** Whole document with HTML, JS and CSS comments removed. */
  stripped: string;
}

const SEG_RE =
  /<!--[\s\S]*?(?:-->|$)|<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)|<style\b([^>]*)>([\s\S]*?)(?:<\/style\s*>|$)/gi;

export function parsePiece(html: string): ParsedPiece {
  let markup = "";
  let stripped = "";
  const scripts: ParsedPiece["scripts"] = [];
  const styles: string[] = [];
  let pos = 0;
  for (const m of html.matchAll(SEG_RE)) {
    const before = html.slice(pos, m.index);
    markup += before;
    stripped += before;
    pos = m.index + m[0].length;
    if (m[0].startsWith("<!--")) continue;
    if (m[1] !== undefined || m[2] !== undefined) {
      const attrs = m[1] ?? "";
      const scan = scanJs(m[2] ?? "");
      scripts.push({ attrs, scan });
      markup += `<script${attrs}>`;
      stripped += `<script${attrs}>${scan.code}</script>`;
    } else {
      const attrs = m[3] ?? "";
      const css = (m[4] ?? "").replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
      styles.push(css);
      markup += `<style${attrs}>`;
      stripped += `<style${attrs}>${css}</style>`;
    }
  }
  markup += html.slice(pos);
  stripped += html.slice(pos);
  return { markup, scripts, styles, stripped };
}

// ---------- CSP ----------

export function normalizeCsp(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*/g, "; ")
    .replace(/;\s*$/, "");
}

function cspContents(html: string): string[] {
  return [...html.matchAll(CSP_META_RE)].map((m) => {
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0]);
    return c ? (c[1] ?? c[2] ?? "") : "";
  });
}

const CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="${CANONICAL_CSP}">`;

// Doctype (after an optional BOM, whitespace and comments) stays first so the page never drops into quirks mode.
const DOCTYPE_PREFIX_RE = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype\b[^>]*>/i;

/**
 * Strips every CSP meta (wherever it sits) and puts one canonical tag right after the doctype, or at
 * byte 0 without one. The parser then places it in <head> before any <script>, and it can never land
 * inside a JS string such as "<head>". Idempotent.
 */
export function injectOrVerifyCsp(html: string): string {
  const clean = html.replace(CSP_META_RE, "");
  const at = DOCTYPE_PREFIX_RE.exec(clean)?.[0].length ?? 0;
  return clean.slice(0, at) + CSP_TAG + clean.slice(at);
}

// ---------- checks ----------

// Global-object prefixes that still reach the real API (`window.fetch`), while `o.fetch` and `{ fetch: 1 }` do not.
const GLOBAL_PREFIX = String.raw`(?:(?<![.\w$])|\b(?:window|self|globalThis|top|parent|frames)\s*\??\.\s*)`;
const NETWORK_APIS: Array<[string, RegExp]> = [
  ["fetch", new RegExp(String.raw`${GLOBAL_PREFIX}fetch\b(?!\s*:)`)],
  ["xmlhttprequest", /\bXMLHttpRequest\b/],
  ["websocket", /\bWebSocket\b/],
  ["eventsource", /\bEventSource\b/],
  ["send-beacon", /\bsendBeacon\b/],
  ["import-scripts", /\bimportScripts\b/],
  ["rtc-peer-connection", /PeerConnection|\bRTC(?:Peer|Ice|Data|Rtp|Sctp|Dtls)/],
  ["import", /(?<![.\w$])import\b(?!\s*:|\s*\.\s*meta\b)/],
];
const NETWORK_API_NAMES = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts", "RTCPeerConnection", "eval", "Function", "constructor"]);
// Checked against all string literals of a script joined, so `'RTCPeer' + 'Connection'` still trips.
const SPLIT_NAME_RE = /PeerConnection|RTCPeer|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/;

// Dynamic code and navigation. The canonical CSP blocks eval at runtime; this catches it before the browser.
const CODE_RULES: Array<[string, RegExp, string]> = [
  ["eval", /\beval\b/, "eval"],
  ["function-constructor", /\bFunction\s*\(/, "Function constructor"],
  ["function-constructor", /\.\s*constructor\b/, "constructor property access (Function constructor trick)"],
  ["string-timer", /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/, "string-argument timer"],
  ["navigation", /(?<!\b(?:const|let|var)\s+)\blocation\s*=(?![=>])/, "location assignment"],
  ["navigation", /\blocation\s*\.\s*(?:href|host|hostname|protocol|port|pathname|search|origin)\s*=(?![=>])/, "location assignment"],
  ["navigation", /\blocation\s*\.\s*(?:assign|replace|reload)\s*\(/, "location navigation call"],
  ["navigation", /(?<![.\w$])(?:(?:window|self|globalThis|top|parent|frames|document)\s*\??\.\s*)?open\s*\(/, "window.open / open()"],
];

const URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s"'`<>()\\]*/gi;
const PROTO_RELATIVE_RE = /^\s*\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
const TAG_RE = /<[a-zA-Z][\w:-]*\b[^>]*>/g;
const REF_ATTR_RE =
  /\s(src|href|action|formaction|poster|srcset|xlink:href|background|ping|manifest|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const HANDLER_ATTR_RE = /\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const CSS_IMAGE_SET_RE = /image-set\(([^;{}]*)\)/gi;
const SAFE_REF_RE = /^\s*(?:data:|blob:|#|$)/i;

const codePoint = (n: number): string => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd");

/** CSS escapes (`\75 rl(` is `url(`) decoded, so escaped URLs cannot hide from the url() scan. */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-f]{1,6})\s?|\\([^\n0-9a-f])/gi, (_, hex: string | undefined, ch: string | undefined) =>
    hex ? codePoint(parseInt(hex, 16)) : ch!,
  );
}

/** Numeric and the few named entities that can spell a URL scheme, plus the control chars browsers drop from one. */
function normalizeUrlAttr(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => codePoint(Number(d)))
    .replace(/&colon;/gi, ":")
    .replace(/&(?:tab|newline);/gi, "")
    .replace(/[\u0000-\u0020]/g, "");
}

/** srcset candidate URLs (spec-ish: a URL is a run of non-whitespace, so commas inside data: URLs stay put). */
function srcsetUrls(v: string): string[] {
  return [...v.matchAll(/(?:^|,)\s*(\S+)/g)].map((m) => m[1]!.replace(/,+$/, ""));
}

function isExecutableScript(attrs: string): boolean {
  const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const t = (type ? (type[1] ?? type[2] ?? type[3] ?? "") : "").trim().toLowerCase();
  return t === "" || t === "module" || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(t);
}

function snippet(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function collectUrls(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0]).filter((u) => !ALLOWED_URLS.has(u));
}

function countColours(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})(?![\w-])/gi)) {
    let h = m[1]!.toLowerCase();
    if (h.length === 3) h = [...h].map((x) => x + x).join("");
    out.add(`#${h}`);
  }
  for (const m of text.matchAll(/\b(?:rgba?|hsla?)\([^)]*\)/gi)) out.add(m[0].toLowerCase().replace(/\s+/g, ""));
  return [...out];
}

export function lintPieceHtml(html: string, options: LintOptions): LintResult {
  const v: SlopViolation[] = [];
  const add = (rule: string, detail: string): void => {
    if (!v.some((x) => x.rule === rule && x.detail === detail)) v.push({ rule, detail });
  };
  const piece = parsePiece(html);
  const tags = [...piece.markup.matchAll(TAG_RE)].map((m) => m[0]);

  // Inline event handlers are JS too.
  const handlers = tags.flatMap((t) => [...t.matchAll(HANDLER_ATTR_RE)].map((m) => scanJs(m[1] ?? m[2] ?? m[3] ?? "")));
  // Only executable scripts are JS; shader sources in <script type="x-shader/..."> are not (GLSL `layout(location = 0)`).
  // Their bodies still go through the URL-literal and slop scans on `stripped`.
  const jsScans = [...piece.scripts.filter((s) => isExecutableScript(s.attrs)).map((s) => s.scan), ...handlers];

  // Network APIs, on code with string contents blanked (so prose in strings does not trip),
  // plus any string literal that is exactly an API name (bracket access).
  for (const scan of jsScans) {
    for (const [id, re] of NETWORK_APIS) {
      const m = re.exec(scan.noStr);
      if (m) add(`security/${id}`, `network API '${m[0]}' near: ${snippet(scan.code.slice(m.index, m.index + 60))}`);
    }
    for (const s of scan.strings) {
      if (NETWORK_API_NAMES.has(s.trim())) add("security/network-api-string", `string literal '${s.trim()}' names a network or code API`);
      if (PROTO_RELATIVE_RE.test(s)) add("security/url-literal", `protocol-relative URL in string: ${snippet(s)}`);
      if (/^javascript:/i.test(normalizeUrlAttr(s))) add("security/javascript-uri", `javascript: URI in string: ${snippet(s)}`);
    }
    const joined = scan.strings.join("");
    const split = SPLIT_NAME_RE.exec(joined);
    if (split) add("security/network-api-string", `string literals spell '${split[0]}'`);
    for (const [id, re, what] of CODE_RULES) {
      const m = re.exec(scan.noStr);
      if (m) add(`security/${id}`, `${what} near: ${snippet(scan.code.slice(m.index, m.index + 60))}`);
    }
  }

  // URL literals anywhere outside comments, except the CSP meta itself and namespace URIs.
  for (const u of collectUrls(piece.stripped.replace(CSP_META_RE, ""))) add("security/url-literal", `URL literal: ${snippet(u)}`);

  // External references in markup.
  for (const t of tags) {
    if (/^<script\b/i.test(t) && /\ssrc\s*=/i.test(t)) add("security/external-script", snippet(t));
    if (/^<link\b/i.test(t) && /\shref\s*=/i.test(t)) add("security/external-link", snippet(t));
    if (/^<base\b/i.test(t)) add("security/base-tag", snippet(t));
    if (/^<meta\b/i.test(t) && /http-equiv\s*=\s*["']?refresh/i.test(t)) add("security/meta-refresh", snippet(t));
    if (/^<form\b/i.test(t)) add("security/form", snippet(t));
    for (const m of t.matchAll(REF_ATTR_RE)) {
      const raw = m[2] ?? m[3] ?? m[4] ?? "";
      const val = normalizeUrlAttr(raw);
      if (/^javascript:/i.test(val)) add("security/javascript-uri", `${m[1]}="${snippet(raw)}" in ${snippet(t, 60)}`);
      else if (m[1]!.toLowerCase() === "srcset") {
        for (const u of srcsetUrls(raw)) if (!SAFE_REF_RE.test(normalizeUrlAttr(u))) add("security/external-ref", `srcset candidate "${snippet(u)}" in ${snippet(t, 60)}`);
      } else if (!SAFE_REF_RE.test(val)) add("security/external-ref", `${m[1]}="${snippet(raw)}" in ${snippet(t, 60)}`);
    }
  }
  const cssText = decodeCssEscapes([...piece.styles, ...tags].join("\n"));
  for (const m of cssText.matchAll(CSS_URL_RE)) {
    if (!SAFE_REF_RE.test(m[2] ?? "")) add("security/css-url", `url(${snippet(m[2] ?? "")})`);
  }
  for (const m of cssText.matchAll(CSS_IMAGE_SET_RE)) {
    for (const q of m[1]!.matchAll(/(["'])(.*?)\1/g)) {
      if (!SAFE_REF_RE.test(q[2] ?? "")) add("security/css-url", `image-set("${snippet(q[2] ?? "")}")`);
    }
  }
  if (piece.styles.some((s) => /@import\b/i.test(decodeCssEscapes(s)))) add("security/css-import", "@import in <style>");

  // CSP: absent is fine for builder output (publish injects it) unless required; present must be canonical.
  const csp = cspContents(piece.markup);
  if (!csp.length && options.requireCsp) add("csp/missing", `missing CSP meta: ${CANONICAL_CSP}`);
  for (const c of csp) {
    if (normalizeCsp(c) !== CANONICAL_CSP) add("csp/mismatch", `CSP '${snippet(c, 160)}' is not the canonical policy`);
  }
  if (csp.length > 1) add("csp/duplicate", `${csp.length} CSP meta tags`);

  // Size.
  const byteSize = Buffer.byteLength(html, "utf8");
  const sizeOk = byteSize <= options.sizeBudgetBytes;
  if (!sizeOk) add("size/over-budget", `${byteSize} bytes > budget ${options.sizeBudgetBytes}`);

  // Constraint night.
  const constraint = (options.constraint ?? "").toLowerCase();
  if (constraint) {
    const hasCanvasTag = tags.some((t) => /^<canvas\b/i.test(t));
    const makesCanvas = jsScans.some((s) => /\bOffscreenCanvas\b/.test(s.noStr) || /createElement\(\s*["'`]canvas/i.test(s.code));
    if (/css/.test(constraint)) {
      if (piece.scripts.length || handlers.length) add("constraint/css-only", "CSS-only night: <script> or inline handler present");
      if (hasCanvasTag) add("constraint/css-only", "CSS-only night: <canvas> present");
    }
    if (/no[\s-]?canvas|without[\s-]canvas/.test(constraint) && (hasCanvasTag || makesCanvas)) {
      add("constraint/no-canvas", "no-canvas night: canvas element present or created");
    }
    if (/(?:two|2)[\s-]?colou?rs?/.test(constraint)) {
      const colours = countColours(piece.stripped.replace(CSP_META_RE, ""));
      if (colours.length > 2) add("constraint/two-colour", `${colours.length} distinct colours: ${colours.slice(0, 8).join(", ")}`);
    }
  }

  // Slop rules from config/slop.yml, on comment-stripped source. Fresh RegExp per call (no lastIndex carry-over).
  for (const r of options.slopRules) applySlopRule(r, piece.stripped, add);

  return {
    passed: v.length === 0,
    byte_size: byteSize,
    size_budget_bytes: options.sizeBudgetBytes,
    size_ok: sizeOk,
    violations: v,
  };
}

function applySlopRule(r: SlopRule, text: string, add: (rule: string, detail: string) => void): void {
  const re = new RegExp(r.pattern, (r.flags ?? "").replace(/[gy]/g, ""));
  const m = re.exec(text);
  if (m) add(`slop/${r.id}`, `${r.message} (matched: ${snippet(m[0], 60)})`);
}
