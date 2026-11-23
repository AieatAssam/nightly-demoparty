import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findRepoRoot } from "../harness/config.js";
import type { Meta } from "../harness/types.js";
import { collectAuditFiles, runSloplint, verdictProblems, type SlopReport } from "../site/audit.js";
import { buildSite, PREVIEW_SHELVED_DATE, PREVIEW_SHELVED_REASON, stagePreview } from "../site/build.js";
import { esc, padTimeline, safeUrl } from "../site/src/pages.js";

const ROOT = findRepoRoot();
const tmp = mkdtempSync(join(tmpdir(), "site-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const XSS = `<script>alert(1)</script>"'&`;
const PUBLISHED = "2026-11-24";
const BSIDES = ["2026-11-23", "2026-11-25"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? walk(join(dir, e)).map((f) => `${e}/${f}`) : [e]));
}
const htmlFiles = (out: string): string[] => walk(out).filter((f) => f.endsWith(".html") && !f.endsWith("piece.html"));
const read = (out: string, f: string): string => readFileSync(join(out, f), "utf8");
const attrs = (html: string): string[] => [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
const section = (html: string, cls: string): string => {
  const at = html.indexOf(`<section class="${cls}"`);
  return at < 0 ? "" : html.slice(at, html.indexOf("</section>", at));
};

/** Every page: no root-absolute URL, every internal link resolves, every external anchor is https? with noopener. */
function checkLinks(out: string): void {
  for (const f of htmlFiles(out)) {
    const html = read(out, f);
    expect(html, f).not.toMatch(/(?:href|src)="\//);
    for (const u of attrs(html)) {
      if (/^https?:\/\//.test(u) || u.startsWith("#")) continue;
      expect(u, `${f}: ${u}`).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      const target = posix.normalize(posix.join(posix.dirname(f), u.split("#")[0]!.split("?")[0]!));
      expect(existsSync(join(out, target)), `${f} links to missing ${u}`).toBe(true);
    }
    for (const a of html.match(/<a\b[^>]*href="https?:[^>]*>/g) ?? []) expect(a, f).toContain('rel="noopener noreferrer"');
  }
}

function checkHtml(out: string): void {
  for (const f of htmlFiles(out)) {
    const html = read(out, f);
    expect(html.trimStart().toLowerCase().startsWith("<!doctype html>"), f).toBe(true);
    expect(html, f).toMatch(/<html lang="en">/);
    expect(html, f).toMatch(/<title>[^<]+<\/title>/);
    expect(html, f).toMatch(/<meta name="description" content="[^"]+">/);
    expect(html.match(/<h1\b/g)?.length, f).toBe(1);
    expect(html.match(/<main\b/g)?.length, f).toBe(1);
    expect(html.match(/<section\b/g)?.length, f).toBe(html.match(/<\/section>/g)?.length);
  }
}

describe("empty build (no nights yet)", () => {
  const out = join(tmp, "empty");
  const emptySite = join(tmp, "empty-site");
  let written: string[] = [];
  beforeAll(() => {
    mkdirSync(emptySite, { recursive: true });
    written = buildSite({ repoRoot: ROOT, outDir: out, siteDir: emptySite, ledgerPath: join(tmp, "none.jsonl"), statePath: join(ROOT, "state", "emotion.json") });
  });

  test("writes the four top-level pages and the shared assets", () => {
    for (const f of ["index.html", "archive/index.html", "crew/index.html", "monthly/index.html", "assets/gallery.css", "assets/archive.js"]) {
      expect(written).toContain(f);
      expect(existsSync(join(out, f)), f).toBe(true);
    }
  });

  test("pages are well formed and every link is relative and resolves", () => {
    checkHtml(out);
    checkLinks(out);
  });

  test("each empty page says plainly what is missing", () => {
    expect(read(out, "index.html")).toContain("Nothing has run yet");
    expect(read(out, "archive/index.html")).toContain("Nothing has shipped yet");
    expect(read(out, "monthly/index.html")).toContain("No month has closed with a showcase yet");
    expect(read(out, "crew/index.html")).toContain("No night has been shelved yet");
  });

  test("crew timeline falls back to the engine baseline", () => {
    const crew = read(out, "crew/index.html");
    expect(crew).toMatch(/<svg class="chart pad-timeline"[^>]*role="img"/);
    expect(crew).toContain("baseline");
  });

  test("refuses to clear a folder that holds the repo", () => {
    expect(() => buildSite({ repoRoot: ROOT, outDir: ROOT, siteDir: emptySite, ledgerPath: "x", statePath: "x" })).toThrow(/refusing/);
    expect(() => buildSite({ repoRoot: ROOT, outDir: tmp, siteDir: emptySite, ledgerPath: "x", statePath: "x" })).toThrow(/refusing/);
  });
});

describe("populated build from the staged dry runs", () => {
  const out = join(tmp, "preview");
  const shelvedOut = join(tmp, "shelved");
  let staged: ReturnType<typeof stagePreview>;
  const statePath = join(tmp, "emotion.json");

  beforeAll(() => {
    staged = stagePreview(ROOT);
    // Poison one B-side with hostile strings in every free-text field the gallery prints.
    const metaPath = join(staged.siteDir, "pieces", BSIDES[0]!, "meta.json");
    const m = JSON.parse(readFileSync(metaPath, "utf8")) as Meta;
    m.brief!.title = `Title ${XSS}`;
    m.brief!.concept = `Concept ${XSS}`;
    m.brief!.techniques = [...m.brief!.techniques, `tech ${XSS}`];
    m.liner_note = `Liner ${XSS}`;
    const best = m.attempts.find((a) => a.attempt === m.best_attempt)!;
    best.verdict!.evidence.mechanism = `Evidence ${XSS}`;
    m.dossier!.facts = [
      ...m.dossier!.facts,
      { claim: "c", source_url: "javascript:alert(1)", source_title: "js" },
      { claim: "c", source_url: "data:text/html,<script>alert(1)</script>", source_title: "data" },
      { claim: "c", source_url: `https://example.org/a?q="><script>alert(1)</script>`, source_title: `Source ${XSS}` },
    ];
    writeFileSync(metaPath, JSON.stringify(m));
    writeFileSync(
      statePath,
      JSON.stringify({ baseline: [0.1, 0.2, 0.3], mood: [0.1, 0.2, 0.3], sentiments: { "topic:tidal locking": { liking: 0.6 }, "topic:spirograph": { liking: -0.4 }, "agent:x": { liking: 1 } } }),
    );
    buildSite({ repoRoot: ROOT, outDir: out, siteDir: staged.siteDir, ledgerPath: staged.ledgerPath, statePath, preview: staged.preview });
  });
  afterAll(() => rmSync(dirname(staged.siteDir), { recursive: true, force: true }));

  test("writes every page, including the 2026-11 showcase, and no shelved piece page", () => {
    for (const f of ["index.html", "archive/index.html", "crew/index.html", "monthly/index.html", "monthly/2026-11/index.html"]) expect(existsSync(join(out, f)), f).toBe(true);
    for (const d of [PUBLISHED, ...BSIDES]) {
      expect(existsSync(join(out, "pieces", d, "index.html")), d).toBe(true);
      expect(existsSync(join(out, "pieces", d, "piece.html")), d).toBe(true);
    }
    expect(existsSync(join(out, "pieces", PREVIEW_SHELVED_DATE))).toBe(false);
  });

  test("pages are well formed and every link is relative and resolves", () => {
    checkHtml(out);
    checkLinks(out);
  });

  test("front hero plays the published piece in a sandbox; B-sides sit on their own shelf", () => {
    const front = read(out, "index.html");
    const hero = section(front, "hero");
    expect(hero).toContain(`<iframe sandbox="allow-scripts" src="pieces/${PUBLISHED}/piece.html"`);
    expect(hero).not.toMatch(/allow-same-origin/);
    for (const d of BSIDES) expect(hero).not.toContain(d);
    const shelf = section(front, "b-sides");
    expect(shelf).toContain("B-sides shelf");
    for (const d of BSIDES) expect(shelf).toContain(`pieces/${d}/index.html`);
    expect(shelf).not.toContain(`pieces/${PUBLISHED}/`);
  });

  test("full screen opens a sandboxed stage.html wrapper, never piece.html top-level", () => {
    for (const d of [PUBLISHED, ...BSIDES]) {
      const stage = read(out, `pieces/${d}/stage.html`);
      expect(stage, d).toMatch(/<iframe sandbox="allow-scripts" src="piece\.html"/);
      expect(stage, d).not.toMatch(/allow-same-origin/);
      expect(stage, d).toContain('href="index.html"');
      expect(stage, d).toContain('href="../../index.html"');
      expect(stage, d).toContain('href="../../assets/gallery.css"');
    }
    expect(existsSync(join(out, "pieces", PREVIEW_SHELVED_DATE, "stage.html"))).toBe(false);
    expect(read(out, "index.html")).toContain(`href="pieces/${PUBLISHED}/stage.html"`);
    expect(read(out, `pieces/${PUBLISHED}/index.html`)).toContain('href="stage.html"');
    for (const f of htmlFiles(out)) expect(read(out, f), f).not.toMatch(/<a\b[^>]*href="[^"]*piece\.html"/);
    expect(collectAuditFiles(out)).toContain(`pieces/${PUBLISHED}/stage.html`);
  });

  test("crew timeline tells the three PAD series apart by stroke pattern, from theme tokens only", () => {
    const css = readFileSync(join(ROOT, "site", "src", "gallery.css"), "utf8");
    const rule = (sel: string): string => css.match(new RegExp(`^${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    expect(rule(".chart .s1")).toContain("var(--color-accent)");
    expect(rule(".chart .s1")).not.toContain("dasharray");
    expect(rule(".chart .s2")).toContain("stroke-dasharray: 6 4");
    expect(rule(".chart .s3")).toContain("stroke-dasharray: 2 4");
    expect(rule(".swatch.k2")).toContain("dashed");
    expect(rule(".swatch.k3")).toContain("dotted");
    // No literal colour outside :root.
    const body = css.slice(css.indexOf("}", css.indexOf(":root {")) + 1);
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|oklch)a?\(/i);
  });

  test("a latest shelved night shows the no-release card with its exact reason", () => {
    const reason = `${PREVIEW_SHELVED_REASON} <b>${XSS}</b>`;
    const p = join(staged.siteDir, "pieces", PREVIEW_SHELVED_DATE, "meta.json");
    const m = JSON.parse(readFileSync(p, "utf8")) as Meta;
    writeFileSync(p, JSON.stringify({ ...m, reason }));
    try {
      buildSite({ repoRoot: ROOT, outDir: shelvedOut, siteDir: staged.siteDir, ledgerPath: staged.ledgerPath, statePath });
    } finally {
      writeFileSync(p, JSON.stringify(m));
    }
    const front = read(shelvedOut, "index.html");
    expect(front).toContain('id="no-release"');
    expect(front).toContain("No release tonight");
    expect(front).toContain(esc(reason));
    expect(front).not.toContain("<b><script>");
    expect(front).not.toContain("<iframe");
    expect(front).toContain(`datetime="${PREVIEW_SHELVED_DATE}"`);
  });

  test("piece page: sandboxed frame, liner note, https sources only, mood plot, full rubric, attempts", () => {
    const html = read(out, `pieces/${PUBLISHED}/index.html`);
    expect(html).toMatch(/<iframe sandbox="allow-scripts" src="piece\.html"/);
    expect(html).toContain('id="note"');
    expect(html).toMatch(/<a href="https:\/\/[^"]+" rel="noopener noreferrer">/);
    expect(html).toMatch(/<svg class="chart pad-plot"[^>]*role="img"/);
    const score = html.slice(html.indexOf('aria-labelledby="score-h"'), html.indexOf('aria-labelledby="attempts-h"'));
    const m = JSON.parse(readFileSync(join(staged.siteDir, "pieces", PUBLISHED, "meta.json"), "utf8")) as Meta;
    const v = m.attempts.find((a) => a.attempt === m.best_attempt)!.verdict!;
    for (const name of ["Mechanism", "Ambition", "Craft", "Distinctness", "Polish"]) expect(score).toContain(`>${name}<`);
    for (const k of Object.keys(v.scores) as Array<keyof typeof v.scores>) expect(score).toContain(`>${v.scores[k]}<`);
    expect(score).toContain("75");
    expect(score).toContain(staged.preview.pieceNotes[PUBLISHED]!);
    const attempts = html.slice(html.indexOf('aria-labelledby="attempts-h"'));
    expect(attempts.match(/<tr>/g)?.length).toBe(m.attempts.length + 1);
  });

  test("hostile strings are escaped everywhere and bad source URLs are dropped", () => {
    for (const f of htmlFiles(out)) {
      const html = read(out, f);
      expect(html, f).not.toContain("<script>alert");
      expect(html, f).not.toMatch(/(?:href|src)="(?:javascript|data):/i);
    }
    const piece = read(out, `pieces/${BSIDES[0]}/index.html`);
    for (const label of ["Title", "Concept", "Liner", "Evidence"]) expect(piece, label).toContain(`${label} &lt;script&gt;alert(1)&lt;/script&gt;`);
    expect(piece).not.toContain(">js<");
    expect(piece).not.toContain(">data<");
    expect(piece).toContain('href="https://example.org/a?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E" rel="noopener noreferrer"');
    expect(piece).toContain("Source &lt;script&gt;");
    expect(read(out, "archive/index.html")).toContain(`|${esc(`tech ${XSS}`)}"`);
  });

  test("crew timeline date labels stay at least 298 units apart for any number of nights", () => {
    const pad = { pleasure: 0, arousal: 0, dominance: 0 };
    for (let n = 2; n <= 40; n++) {
      const pts = Array.from({ length: n }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, pad }));
      const xs = [...padTimeline(pts, null).matchAll(/<text x="([\d.]+)"[^>]*>2026-/g)].map((m) => Number(m[1]));
      expect(xs.length, String(n)).toBeLessThanOrEqual(4);
      expect(xs[xs.length - 1], String(n)).toBe(Math.max(...xs));
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!, `n=${n}`).toBeGreaterThanOrEqual(298);
    }
  });

  test("safeUrl keeps only http and https", () => {
    expect(safeUrl("https://a.org/x")).toBe("https://a.org/x");
    expect(safeUrl("http://a.org/")).toBe("http://a.org/");
    for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "/root", "../up", "ftp://a.org", "", null, 3]) expect(safeUrl(bad), String(bad)).toBeNull();
  });

  test("archive covers carry filter data attributes and relative screenshots", () => {
    const html = read(out, "archive/index.html");
    const covers = html.match(/<li class="cover"[^>]*>/g) ?? [];
    expect(covers).toHaveLength(3);
    for (const c of covers) for (const a of ["data-compo", "data-domain", "data-mood", "data-shelf", "data-techniques"]) expect(c).toContain(`${a}="`);
    expect(html).toContain('data-shelf="published"');
    expect(html).toContain('data-shelf="b-side"');
    for (const d of [PUBLISHED, ...BSIDES]) expect(html).toContain(`src="../pieces/${d}/shot-08s.png"`);
    expect(html).toContain('<script src="../assets/archive.js"');
  });

  test("crew page: SVG timeline, likes and dislikes, streaks, shelved reasons", () => {
    const html = read(out, "crew/index.html");
    expect(html).toMatch(/<svg class="chart pad-timeline"[^>]*aria-label="[^"]*over 4 nights/);
    const tastes = html.slice(html.indexOf('aria-labelledby="tastes-h"'));
    expect(tastes).toContain("tidal locking");
    expect(tastes).toContain("spirograph");
    expect(tastes).not.toContain("agent:x");
    expect(html).toMatch(/<b>1<\/b><span>published<\/span>/);
    expect(html).toMatch(/<b>2<\/b><span>B-sides<\/span>/);
    expect(html).toMatch(/<b>1<\/b><span>shelved<\/span>/);
    expect(html).toMatch(/<b>1<\/b><span>shelved in a row, now<\/span>/);
    expect(html).toContain(esc(PREVIEW_SHELVED_REASON));
  });

  test("monthly pages link back to pieces with relative paths", () => {
    expect(read(out, "monthly/index.html")).toContain('href="2026-11/index.html"');
    const month = read(out, "monthly/2026-11/index.html");
    expect(month).toContain(`href="../../pieces/${PUBLISHED}/index.html"`);
    expect(month).toContain(`src="../../pieces/${PUBLISHED}/shot-08s.png"`);
    expect(month).toContain('href="../../assets/gallery.css"');
  });

  test("Hallmark static tier finds no FAIL or REFLEX in the built pages", () => {
    const files = collectAuditFiles(out);
    expect(files).toContain("index.html");
    expect(files).toContain("assets/gallery.css");
    expect(files.some((f) => f.endsWith("piece.html"))).toBe(false);
    const report = runSloplint(files.map((f) => join(out, f)), { repoRoot: ROOT, render: false });
    const bad = report.findings.filter((f) => ["FAIL", "REFLEX", "WAIVER"].includes(f.grade));
    expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
    expect(report.summary.fails).toBe(0);
    expect(report.summary.reflex).toBe(0);
  });
});

describe("audit verdict", () => {
  const report = (over: Partial<SlopReport["summary"]>, findings: SlopReport["findings"] = []): SlopReport => ({
    summary: { fails: 0, reflex: 0, warns: 0, waived: 0, render: "ran", files: 5, ...over },
    findings,
  });
  const f = (grade: string) => ({ gate: "1", grade, file: "x", line: 1, evidence: "e" });

  test("passes a clean rendered report, warnings and dismissals included", () => {
    expect(verdictProblems(report({ warns: 2 }, [f("WARN"), f("DISMISSED"), f("NOTE")]))).toEqual([]);
  });
  test("fails when the render tier did not run, on FAIL, and on unwaived REFLEX", () => {
    expect(verdictProblems(report({ render: "not run: no Chrome" }))[0]).toMatch(/render tier did not run/);
    expect(verdictProblems(report({ render: "off" }))).toHaveLength(1);
    expect(verdictProblems(report({ fails: 1 }, [f("FAIL")]))).toEqual(["1 FAIL"]);
    expect(verdictProblems(report({ reflex: 1 }, [f("REFLEX")]))).toEqual(["1 unwaived REFLEX"]);
  });
});

describe("own copy and code", () => {
  const own = [
    ...readdirSync(join(ROOT, "site", "src")).map((f) => join("site", "src", f)),
    "site/build.ts",
    "site/audit.ts",
    "tests/site.test.ts",
  ];
  const DASH = String.fromCharCode(0x2014);
  const BANNED_MODEL = ["Son", "net"].join("");
  test.each(own)("%s has no em-dash, no banned model name, no short engine name", (f) => {
    const text = readFileSync(join(ROOT, f), "utf8");
    expect(text.includes(DASH), relative(ROOT, f)).toBe(false);
    expect(text.includes(BANNED_MODEL)).toBe(false);
    expect(text).not.toMatch(new RegExp(`\\b${"em"}o\\b`, "i"));
  });
});
