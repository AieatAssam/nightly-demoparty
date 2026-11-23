// Hallmark acceptance gate for the built gallery (SPEC Section 10): runs sloplint with the render tier over every
// gallery page, each full-screen stage wrapper and the stylesheet. Raw generative pieces (pieces/*/piece.html) are left out: per SPEC Section 6,
// Hallmark covers the UI, not the pieces.
// Usage: tsx site/audit.ts [--dir site/dist]
// Fails when the render tier did not run, on any FAIL, and on any unwaived REFLEX.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findRepoRoot } from "../harness/config.js";

export interface SlopFinding {
  gate: string;
  grade: string;
  file: string;
  line: number;
  evidence: string;
  fix?: string;
}

export interface SlopReport {
  summary: { fails: number; reflex: number; warns: number; waived: number; render: string; files: number };
  findings: SlopFinding[];
}

const PAGE_RE = /^(index\.html|archive\/index\.html|crew\/index\.html|monthly\/index\.html|monthly\/\d{4}-\d{2}\/index\.html|pieces\/\d{4}-\d{2}-\d{2}\/(?:index|stage)\.html|assets\/[^/]+\.css)$/;

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (e === ".hallmark") return [];
    return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split("\\").join("/")];
  });
}

/** Gallery pages and stylesheets under dir, relative paths, sorted. piece.html files never match. */
export function collectAuditFiles(dir: string): string[] {
  return walk(dir).filter((f) => PAGE_RE.test(f)).sort();
}

export function findChrome(): string | null {
  const fixed = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"];
  const hit = fixed.find((p) => p && existsSync(p));
  if (hit) return hit;
  try {
    const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: { executablePath(): string } };
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Why the report fails the gate; empty when it passes. */
export function verdictProblems(r: SlopReport): string[] {
  const out: string[] = [];
  if (r.summary.render !== "ran") out.push(`render tier did not run (${r.summary.render})`);
  const fails = r.findings.filter((f) => f.grade === "FAIL" || f.grade === "WAIVER");
  const reflex = r.findings.filter((f) => f.grade === "REFLEX");
  if (fails.length || r.summary.fails) out.push(`${Math.max(fails.length, r.summary.fails)} FAIL`);
  if (reflex.length || r.summary.reflex) out.push(`${Math.max(reflex.length, r.summary.reflex)} unwaived REFLEX`);
  return out;
}

export function runSloplint(files: string[], o: { repoRoot: string; render: boolean; chrome?: string | null }): SlopReport {
  const script = join(o.repoRoot, ".claude", "skills", "hallmark", "scripts", "sloplint.mjs");
  const args = [script, ...files, "--genre", "atmospheric", "--json", ...(o.render ? ["--render"] : [])];
  const env = { ...process.env, ...(o.chrome ? { CHROME_PATH: o.chrome } : {}) };
  // cwd is the repo root so the render tier resolves puppeteer-core from node_modules.
  const r = spawnSync(process.execPath, args, { cwd: o.repoRoot, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  try {
    return JSON.parse(r.stdout) as SlopReport;
  } catch {
    throw new Error(`sloplint did not return JSON (exit ${r.status}): ${r.stderr || r.stdout}`.slice(0, 2000));
  }
}

function clean(dir: string): void {
  const visit = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (!statSync(p).isDirectory()) continue;
      if (e === ".hallmark") rmSync(p, { recursive: true, force: true });
      else visit(p);
    }
  };
  visit(dir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: { dir: { type: "string" } } });
  const repoRoot = findRepoRoot();
  const dir = resolve(v.dir ?? join(repoRoot, "site", "dist"));
  if (!existsSync(join(dir, "index.html"))) {
    console.error(`site:audit: ${dir} has no index.html; run npm run site:build first`);
    process.exit(2);
  }
  const files = collectAuditFiles(dir);
  const chrome = findChrome();
  console.log(`site:audit: ${files.length} files in ${dir}, Chrome: ${chrome ?? "not found"}`);
  let report: SlopReport;
  try {
    report = runSloplint(files.map((f) => join(dir, f)), { repoRoot, render: true, chrome });
  } finally {
    clean(dir);
  }
  for (const f of report.findings) console.log(`  ${f.grade} ${f.gate} ${f.file}:${f.line} ${f.evidence}${f.fix && (f.grade === "FAIL" || f.grade === "REFLEX") ? ` | fix: ${f.fix}` : ""}`);
  const s = report.summary;
  console.log(`site:audit: ${s.fails} FAIL, ${s.reflex} REFLEX, ${s.warns} WARN, ${s.waived} WAIVED across ${s.files} files; render tier: ${s.render}`);
  const problems = verdictProblems(report);
  if (problems.length) {
    console.error(`site:audit: failed: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("site:audit: passed");
}
