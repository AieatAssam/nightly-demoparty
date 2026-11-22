import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_CSP, injectOrVerifyCsp, lintPieceHtml, normalizeCsp, scanJs } from '../harness/lint.js';
import { loadAllConfig } from '../harness/config.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const slopRules = loadAllConfig(REPO).slop.static_rules;
const fixture = (name: string): string => readFileSync(join(REPO, 'tests', 'fixtures', `${name}.html`), 'utf8');
const page = (body: string, head = ''): string => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body><script>${body}</script></body></html>`;
const lint = (html: string, over: { sizeBudgetBytes?: number; constraint?: string | null; requireCsp?: boolean } = {}) =>
  lintPieceHtml(html, { sizeBudgetBytes: 16384, slopRules, constraint: null, ...over });
const rules = (html: string, over?: Parameters<typeof lint>[1]): string[] => lint(html, over).violations.map((v) => v.rule);

describe('scanJs', () => {
  it('strips comments but keeps URLs and slashes inside strings', () => {
    const scan = scanJs(`// fetch('https://example.org')\nconst s = "http://a.b/c"; /* eval(x) */ const t = 1;`);
    expect(scan.code).not.toMatch(/fetch|eval/);
    expect(scan.code).toMatch(/const s = "http:\/\/a\.b\/c"/);
  });
});

describe('clean pieces', () => {
  it('passes good.html with the canonical CSP', () => {
    const r = lint(fixture('good'));
    expect(r.violations).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.size_ok).toBe(true);
  });

  it('does not flag a URL that appears only in a comment', () => {
    expect(rules(page('/* see https://example.org for notes */ const x = 1;'))).toEqual([]);
  });
});

describe('security rules', () => {
  it('flags a fetch call', () => {
    expect(rules(page("fetch('/data.json');"))).toContain('security/fetch');
  });

  it('flags XMLHttpRequest and WebSocket use', () => {
    expect(rules(page('const x = new XMLHttpRequest();'))).toContain('security/xmlhttprequest');
    expect(rules(page('const w = new WebSocket("ws://x");'))).toContain('security/websocket');
  });

  it('flags eval on non-literal input', () => {
    expect(rules(page('const code = "1+1"; eval(code);'))).toContain('security/eval');
  });

  it('flags a URL literal in a string', () => {
    expect(rules(page('const u = "https://cdn.example.net/a.js";'))).toContain('security/url-literal');
  });

  it('flags an external script src and an external link href', () => {
    expect(rules('<html><head><script src="https://cdn.example.net/x.js"></script></head><body></body></html>')).toContain('security/external-script');
    expect(rules('<html><head><link rel="stylesheet" href="data:text/css,a{}"></head><body></body></html>')).toContain('security/external-link');
  });
});

describe('CSP', () => {
  it('accepts exactly the canonical policy', () => {
    const html = page('const a = 1;', `<meta http-equiv="Content-Security-Policy" content="${CANONICAL_CSP}">`);
    expect(rules(html)).toEqual([]);
  });

  it('flags a CSP that differs from the canonical policy', () => {
    const html = page('const a = 1;', `<meta http-equiv="Content-Security-Policy" content="default-src *">`);
    expect(rules(html)).toContain('csp/mismatch');
  });

  it('flags two CSP meta tags', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CANONICAL_CSP}">`;
    expect(rules(page('const a = 1;', meta + meta))).toContain('csp/duplicate');
  });

  it('flags a missing CSP only when one is required', () => {
    expect(rules(page('const a = 1;'))).not.toContain('csp/missing');
    expect(rules(page('const a = 1;'), { requireCsp: true })).toContain('csp/missing');
  });

  it('injectOrVerifyCsp adds one canonical tag and is idempotent', () => {
    const once = injectOrVerifyCsp(page('const a = 1;'));
    expect(normalizeCsp(once.match(/content="([^"]*)"/)![1]!)).toBe(CANONICAL_CSP);
    expect(injectOrVerifyCsp(once)).toBe(once);
    expect(rules(once)).toEqual([]);
  });

  it('injectOrVerifyCsp puts the tag right after the doctype, or at byte 0 without one', () => {
    const tag = `<meta http-equiv="Content-Security-Policy" content="${CANONICAL_CSP}">`;
    expect(injectOrVerifyCsp('<!doctype html><html><head></head></html>')).toBe(`<!doctype html>${tag}<html><head></head></html>`);
    expect(injectOrVerifyCsp('\uFEFF<!-- hi -->\n<!DOCTYPE html><p>x')).toBe(`\uFEFF<!-- hi -->\n<!DOCTYPE html>${tag}<p>x`);
    expect(injectOrVerifyCsp('<p>x</p>')).toBe(`${tag}<p>x</p>`);
  });

  it('injectOrVerifyCsp never lands inside a script string that mentions <head>, and strips CSP tags anywhere', () => {
    const html = `<!doctype html><script>const s = "<head>";</script><html><head></head><body><meta http-equiv="content-security-policy" content="default-src *"></body></html>`;
    const fixed = injectOrVerifyCsp(html);
    expect(fixed.match(/Content-Security-Policy/gi)).toHaveLength(1);
    expect(fixed).toContain('const s = "<head>";');
    expect(fixed.indexOf('Content-Security-Policy')).toBeLessThan(fixed.indexOf('<script>'));
  });

  it('injectOrVerifyCsp replaces a mismatched policy with the canonical one', () => {
    const bad = page('const a = 1;', `<meta http-equiv="Content-Security-Policy" content="default-src *">`);
    const fixed = injectOrVerifyCsp(bad);
    expect(fixed.match(/Content-Security-Policy/gi)).toHaveLength(1);
    expect(rules(fixed)).toEqual([]);
  });
});

describe('size and slop rules', () => {
  it('flags a piece over its byte budget', () => {
    const big = page(`const pad = "${'x'.repeat(20000)}";`);
    const r = lint(big, { sizeBudgetBytes: 16384 });
    expect(r.size_ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain('size/over-budget');
  });

  it('flags Math.random driving the render', () => {
    expect(rules(page('ctx.fillRect(Math.random() * 100, 0, 1, 1);'))).toContain('slop/math-random-render');
  });

  it('flags the four-sine plasma boilerplate written with bare sin() calls', () => {
    expect(rules(page('const v = sin(a) + sin(b) + sin(c) + sin(d);'))).toContain('slop/hello-world-plasma');
  });

  it('flags a constraint-night rule break when the constraint is css-only and the piece has JavaScript', () => {
    expect(rules(page('const a = 1;'), { constraint: 'css-only' }).some((r) => r.startsWith('constraint/'))).toBe(true);
  });
});

describe('hardened security rules', () => {
  it('flags every eval and Function constructor form, literal or not', () => {
    expect(rules(page('eval("1+1");'))).toContain('security/eval');
    expect(rules(page('(0, eval)("1");'))).toContain('security/eval');
    expect(rules(page('new Function("return 1")();'))).toContain('security/function-constructor');
    expect(rules(page('(() => {}).constructor("return 1")();'))).toContain('security/function-constructor');
    expect(rules(page('window["eval"]("1");'))).toContain('security/network-api-string');
  });

  it('does not mistake a class constructor for the Function constructor trick', () => {
    expect(rules(page('class Blob2 { constructor(x) { this.x = x; } } new Blob2(1);'))).toEqual([]);
  });

  it('flags string-argument timers', () => {
    expect(rules(page('setTimeout("draw()", 10);'))).toContain('security/string-timer');
    expect(rules(page("setInterval('tick()', 10);"))).toContain('security/string-timer');
    expect(rules(page('setTimeout(() => draw(), 10);'))).toEqual([]);
  });

  it('flags navigation: location writes, location calls, window.open and bare open()', () => {
    for (const js of ['location.href = "x";', 'window.location = "x";', 'document.location.assign("x");', 'location.replace("x");', 'window.open("x");', 'open("x");']) {
      expect(rules(page(js)), js).toContain('security/navigation');
    }
    expect(rules(page('const r = indexedDB.open("db"); const same = location.href === "a";'))).toEqual([]);
    expect(rules(page('const location = gl.getUniformLocation(prog, "t");'))).toEqual([]);
    expect(rules('<html><body><script type="x-shader/x-vertex">#version 300 es\nlayout(location = 0) in vec2 p;</script></body></html>')).toEqual([]);
  });

  it('flags <form>, RTCPeerConnection (direct or spelled from strings) and javascript: URIs', () => {
    expect(rules('<html><body><form><input></form></body></html>')).toContain('security/form');
    expect(rules(page('const pc = new RTCPeerConnection();'))).toContain('security/rtc-peer-connection');
    expect(rules(page('const pc = new webkitRTCPeerConnection();'))).toContain('security/rtc-peer-connection');
    expect(rules(page('const P = window["RTCPeer" + "Connection"];'))).toContain('security/network-api-string');
    expect(rules('<html><body><a href="javascript:alert(1)">x</a></body></html>')).toContain('security/javascript-uri');
    expect(rules('<html><body><a href="jav&#x61;script&colon;alert(1)">x</a></body></html>')).toContain('security/javascript-uri');
    expect(rules(page('a.href = "javascript:void 0";'))).toContain('security/javascript-uri');
  });

  it('flags escaped CSS url(), image-set() with external URLs and later srcset candidates', () => {
    expect(rules('<html><head><style>body{background:\\75rl(/x.png)}</style></head></html>')).toContain('security/css-url');
    expect(rules('<html><head><style>body{background:image-set("/x.png" 1x)}</style></head></html>')).toContain('security/css-url');
    expect(rules('<html><body><img srcset="data:image/png;base64,AAAA 1x, /evil.png 2x"></body></html>')).toContain('security/external-ref');
    expect(rules('<html><body><img srcset="data:image/png;base64,AA,AA 1x, data:image/png;base64,BB 2x"></body></html>')).toEqual([]);
  });

  it('flags global fetch but not a method or key that happens to be named fetch or import', () => {
    for (const js of ['fetch("x");', 'window.fetch("x");', 'self.fetch("x");', 'globalThis.fetch("x");']) {
      expect(rules(page(js)), js).toContain('security/fetch');
    }
    expect(rules(page('const o = { fetch: 1, import: 2 }; o.fetch; o.import; const m = import.meta;'))).toEqual([]);
    expect(rules(page('import("./x.js");'))).toContain('security/import');
  });

  it('flags the four-sine plasma written with Math.sin', () => {
    expect(rules(page('const v = Math.sin(a) + Math.sin(b) + Math.sin(c) + Math.sin(d);'))).toContain('slop/hello-world-plasma');
  });
});
