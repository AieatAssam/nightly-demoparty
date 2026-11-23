// Builds the static gallery into site/dist/ from site/pieces/*/meta.json, site/monthly/*/showcase.json,
// ledger/ledger.jsonl and state/emotion.json. No framework runtime: plain HTML, one stylesheet, one small script.
// Usage: tsx site/build.ts [--out DIR] [--site DIR] [--ledger FILE] [--state FILE] [--preview-dry-runs]
// --preview-dry-runs stages audit/dry-runs/run-01..03 into a temp folder (no repo file is touched) and builds from that.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findRepoRoot, loadCompos } from "../harness/config.js";
import { buildMonthlyShowcase, type ShowcaseEntry } from "../harness/monthly-showcase.js";
import { readLedger } from "../harness/novelty.js";
import type { LedgerEntry, Meta } from "../harness/types.js";
import {
  DATE_RE,
  MONTH_RE,
  renderArchive,
  renderCrew,
  renderFront,
  renderMonth,
  renderMonthlyIndex,
  renderPiece,
  renderStage,
  type EmotionState,
  type PreviewInfo,
  type SiteData,
} from "./src/pages.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "src");
const SHOTS = { t2: "shot-02s.png", t8: "shot-08s.png", t20: "shot-20s.png" } as const;

export interface BuildOptions {
  outDir: string;
  siteDir: string;
  ledgerPath: string;
  statePath: string;
  repoRoot?: string;
  preview?: PreviewInfo;
}

const readJson = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);

function write(out: string, rel: string, html: string, written: string[]): void {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, html);
  written.push(rel);
}

/** Builds the site and returns the written paths, relative to outDir. */
export function buildSite(o: BuildOptions): string[] {
  const repoRoot = o.repoRoot ?? findRepoRoot();
  const out = resolve(o.outDir);
  const siteDir = resolve(o.siteDir);
  for (const keep of [repoRoot, siteDir]) {
    if (!relative(out, keep).startsWith("..") || out === keep) throw new Error(`refusing to clear ${out}: it holds ${keep}`);
  }

  const metas: Meta[] = [];
  const piecesDir = join(siteDir, "pieces");
  for (const d of existsSync(piecesDir) ? readdirSync(piecesDir).sort() : []) {
    const m = DATE_RE.test(d) ? readJson<Meta>(join(piecesDir, d, "meta.json")) : null;
    if (!m || m.date !== d || !["published", "b-side", "shelved"].includes(m.status)) continue;
    metas.push(m);
  }
  const showcases: SiteData["showcases"] = [];
  const monthlyDir = join(siteDir, "monthly");
  for (const d of existsSync(monthlyDir) ? readdirSync(monthlyDir).sort() : []) {
    const s = MONTH_RE.test(d) ? readJson<{ month: string; entries: ShowcaseEntry[] }>(join(monthlyDir, d, "showcase.json")) : null;
    if (s && Array.isArray(s.entries)) showcases.push({ month: d, entries: s.entries });
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "assets"), { recursive: true });
  copyFileSync(join(SRC, "gallery.css"), join(out, "assets", "gallery.css"));
  copyFileSync(join(SRC, "archive.js"), join(out, "assets", "archive.js"));
  const written = ["assets/gallery.css", "assets/archive.js"];

  // Copy each shipped piece as piece.html beside its stills. A shipped night whose piece file is missing
  // drops out of the gallery pages (the ledger still counts it on the crew page) rather than show a broken frame.
  const shots: SiteData["shots"] = {};
  const shown: Meta[] = [];
  for (const m of metas) {
    if (m.status !== "shelved") {
      const src = join(piecesDir, m.date, "index.html");
      if (!m.piece_rel_path || !existsSync(src)) {
        console.warn(`site: ${m.date} is ${m.status} but ${src} is missing; left out of the gallery`);
        continue;
      }
      const dest = join(out, "pieces", m.date);
      mkdirSync(dest, { recursive: true });
      copyFileSync(src, join(dest, "piece.html"));
      written.push(`pieces/${m.date}/piece.html`);
      shots[m.date] = { t2: false, t8: false, t20: false };
      for (const [k, f] of Object.entries(SHOTS) as Array<[keyof typeof SHOTS, string]>) {
        if (!existsSync(join(piecesDir, m.date, f))) continue;
        copyFileSync(join(piecesDir, m.date, f), join(dest, f));
        shots[m.date]![k] = true;
        written.push(`pieces/${m.date}/${f}`);
      }
    }
    shown.push(m);
  }

  const data: SiteData = {
    metas: shown,
    ledger: readLedger(o.ledgerPath, repoRoot),
    emotion: readJson<EmotionState>(o.statePath),
    showcases,
    compos: loadCompos(repoRoot),
    shots,
    preview: o.preview,
  };

  write(out, "index.html", renderFront(data), written);
  write(out, "archive/index.html", renderArchive(data), written);
  write(out, "crew/index.html", renderCrew(data), written);
  write(out, "monthly/index.html", renderMonthlyIndex(data), written);
  for (const s of showcases) write(out, `monthly/${s.month}/index.html`, renderMonth(data, s), written);
  for (const m of shown) {
    if (m.status === "shelved") continue;
    write(out, `pieces/${m.date}/index.html`, renderPiece(data, m), written);
    write(out, `pieces/${m.date}/stage.html`, renderStage(m), written);
  }
  return written;
}

// ---------- preview from the dry runs ----------

export const PREVIEW_SHELVED_DATE = "2026-11-26";
export const PREVIEW_SHELVED_REASON = "Preview fixture: hard gates failed strobe check on all 3 attempts";

function ledgerRow(m: Meta): LedgerEntry {
  const best = m.attempts.find((a) => a.attempt === m.best_attempt);
  const kept = m.status !== "shelved" ? (best?.gates ?? null) : null;
  return {
    date: m.date,
    status: m.status,
    compo: m.plan.compo,
    domain: m.dossier?.domain ?? m.plan.domain,
    topic: m.dossier?.topic ?? null,
    concept: m.brief?.concept ?? null,
    techniques: m.brief?.techniques ?? [],
    technique_family: m.brief?.technique_family ?? null,
    palette: (m.brief?.palette ?? []).map((c) => c.toLowerCase()),
    phashes: kept ? { ...kept.novelty_b.phashes } : { t2: null, t8: null, t20: null },
    color_histogram: kept ? kept.novelty_b.color_histogram : null,
    score: best?.verdict?.total ?? null,
    attempts: m.attempts.length,
    mood_pad: m.mood?.pad ?? null,
    dominant_emotion: m.mood?.dominant_emotions[0]?.label ?? null,
  };
}

/**
 * Stages the three dry runs into a temp site/ and ledger, read-only against the repo:
 * run-02 promoted to a preview published night at 75, run-01 and run-03 kept as B-sides,
 * plus one shelved fixture night, then a monthly showcase for 2026-11.
 */
export function stagePreview(repoRoot: string): { siteDir: string; ledgerPath: string; preview: PreviewInfo } {
  const root = mkdtempSync(join(tmpdir(), "gallery-preview-src-"));
  const siteDir = join(root, "site");
  const metas: Meta[] = [];
  let promoted = "";
  for (const run of ["run-01", "run-02", "run-03"]) {
    const from = join(repoRoot, "audit", "dry-runs", run);
    const m = JSON.parse(readFileSync(join(from, "meta.json"), "utf8")) as Meta;
    if (run === "run-02") {
      const best = m.attempts.find((a) => a.attempt === m.best_attempt)!;
      best.verdict!.scores = { mechanism: 18, ambition: 17, craft: 18, distinctness: 15, polish: 7 };
      best.verdict!.total = 75;
      best.verdict!.pairwise_beats_median = true;
      best.outcome = "passed";
      m.status = "published";
      m.reason = null;
      promoted = m.date;
    }
    const dir = join(siteDir, "pieces", m.date);
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(from, "index.html"), join(dir, "index.html"));
    for (const f of Object.values(SHOTS)) if (existsSync(join(from, f))) copyFileSync(join(from, f), join(dir, f));
    writeFileSync(join(dir, "meta.json"), JSON.stringify(m, null, 2));
    metas.push(m);
  }
  const base = metas[metas.length - 1]!;
  const shelved: Meta = {
    ...structuredClone(base),
    date: PREVIEW_SHELVED_DATE,
    status: "shelved",
    reason: PREVIEW_SHELVED_REASON,
    best_attempt: null,
    attempts: base.attempts.map((a) => ({
      ...structuredClone(a),
      gates: a.gates && {
        ...structuredClone(a.gates),
        passed: false,
        strobe: { ...a.gates.strobe, passed: false },
        failures: [{ gate: "strobe", message: "Preview fixture: flash rate over the limit" }],
      },
      verdict: null,
      outcome: "gates_failed",
    })),
    liner_note: null,
    screenshots: null,
    piece_rel_path: null,
  };
  shelved.plan = { ...shelved.plan, date: PREVIEW_SHELVED_DATE };
  mkdirSync(join(siteDir, "pieces", PREVIEW_SHELVED_DATE), { recursive: true });
  writeFileSync(join(siteDir, "pieces", PREVIEW_SHELVED_DATE, "meta.json"), JSON.stringify(shelved, null, 2));
  metas.push(shelved);

  const ledger = metas.map(ledgerRow);
  const ledgerPath = join(root, "ledger", "ledger.jsonl");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, ledger.map((e) => JSON.stringify(e)).join("\n") + "\n");
  buildMonthlyShowcase({ month: PREVIEW_SHELVED_DATE.slice(0, 7), ledger, siteDir });
  return {
    siteDir,
    ledgerPath,
    preview: {
      note: "Preview build from the three dry runs in audit/dry-runs plus one shelved fixture night. None of these nights ran for real.",
      pieceNotes: { [promoted]: "Preview fixture: this dry run scored 69 and was raised to 75 to show a published night." },
      frontSkip: [PREVIEW_SHELVED_DATE],
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({
    options: {
      out: { type: "string" },
      site: { type: "string" },
      ledger: { type: "string" },
      state: { type: "string" },
      "preview-dry-runs": { type: "boolean", default: false },
    },
  });
  const root = findRepoRoot();
  const staged = v["preview-dry-runs"] ? stagePreview(root) : null;
  const outDir = resolve(v.out ?? join(root, "site", "dist"));
  try {
    const written = buildSite({
      repoRoot: root,
      outDir,
      siteDir: staged?.siteDir ?? resolve(v.site ?? join(root, "site")),
      ledgerPath: staged?.ledgerPath ?? resolve(v.ledger ?? join(root, "ledger", "ledger.jsonl")),
      statePath: resolve(v.state ?? join(root, "state", "emotion.json")),
      preview: staged?.preview,
    });
    process.stdout.write(`site: wrote ${written.length} files to ${outDir}\n`);
  } finally {
    if (staged) rmSync(dirname(staged.siteDir), { recursive: true, force: true });
  }
}
