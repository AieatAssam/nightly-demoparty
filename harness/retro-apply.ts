// Weekly retrospective, both sides of the Opus call (.github/workflows/weekly.yml).
//   tsx harness/retro-apply.ts render --week-ending D --dir DIR   writes DIR/prompt.md (output path DIR/retro.json)
//   tsx harness/retro-apply.ts apply --input DIR/retro.json [--week-ending D] [--report P]
// apply never trusts the model with anything that can break a night: every static regex is compiled and probed in a
// child process with a timeout, after a static nested-quantifier screen and adversarial long-run inputs (it must match
// nothing in lib/min/*.js, the good fixtures, the anchors or the existing
// curriculum snippets), every snippet must pass the piece lint, ids must be new, and the threshold and usage alerts are
// recomputed here. Rejected items are reported and skipped; the rest is written with comments kept, then reloaded.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseDocument, type Document, type YAMLSeq } from "yaml";
import { findRepoRoot, loadCurriculum, loadSlop, loadThresholds } from "./config.js";
import { computeRatchetedThreshold, median30d } from "./decide.js";
import { lintPieceHtml } from "./lint.js";
import { dayNumber, readLedger } from "./novelty.js";
import { renderPrompt } from "./prompt-render.js";
import { validateSchema } from "./schema.js";
import { computeUsageAlerts, readUsage } from "./usage.js";
import type { LedgerEntry, Meta, SlopRule } from "./types.js";

const ROOT = findRepoRoot();
const SNIPPET_BUDGET = 64 * 1024;
const PROBE_TIMEOUT_MS = 2000;

interface Retro {
  week_ending: string;
  nights_reviewed: number;
  summary: string;
  slop_additions: Array<{ id: string; pattern_type: "static" | "visual"; pattern: string; rationale: string }>;
  curriculum_additions: Array<{ id: string; name: string; family: string; how_to: string; snippet: string }>;
  threshold_recommendation: { previous: number; median_30d: number | null; computed: number; applied: number };
  usage_alerts: unknown[];
}

export interface ApplyOptions {
  retro: unknown;
  /** Folder holding config/*.yml to update (the repo, or a copy in tests). */
  configRoot?: string;
  /** Repo that supplies schemas, lib/min, fixtures, anchors, ledger and usage. */
  repoRoot?: string;
  weekEnding?: string;
  ledger?: LedgerEntry[];
  usagePath?: string;
  dryRun?: boolean;
}

export interface ApplyReport {
  ok: boolean;
  errors: string[];
  week_ending: string | null;
  applied: { slop_static: string[]; slop_visual: string[]; curriculum: string[]; publish_min: { from: number; to: number } | null };
  rejected: Array<{ kind: "slop" | "curriculum"; id: string; reason: string }>;
  threshold: { previous: number; median_30d: number | null; computed: number; model_applied: number | null };
  usage_alerts: unknown[];
}

const lastDays = (ledger: LedgerEntry[], end: string, n: number): LedgerEntry[] =>
  ledger.filter((e) => {
    const age = dayNumber(end) - dayNumber(e.date);
    return age >= 0 && age < n;
  });

// ---------- probes ----------

/** Text every static slop rule must leave alone: shared helpers, known-good pieces, the anchors, current snippets. */
export function probeCorpus(repoRoot = ROOT, configRoot = repoRoot): Array<{ name: string; text: string }> {
  const files: string[] = [];
  const add = (dir: string, keep: (f: string) => boolean): void => {
    if (existsSync(dir)) for (const f of readdirSync(dir).sort()) if (keep(f)) files.push(join(dir, f));
  };
  add(join(repoRoot, "lib", "min"), (f) => f.endsWith(".js"));
  add(join(repoRoot, "tests", "fixtures"), (f) => /^good.*\.html$/.test(f));
  for (const d of existsSync(join(repoRoot, "anchors")) ? readdirSync(join(repoRoot, "anchors")).sort() : []) {
    if (existsSync(join(repoRoot, "anchors", d, "index.html"))) files.push(join(repoRoot, "anchors", d, "index.html"));
  }
  return [
    ...files.map((f) => ({ name: f.slice(repoRoot.length + 1), text: readFileSync(f, "utf8") })),
    ...loadCurriculum(configRoot).map((t) => ({ name: `curriculum:${t.id}`, text: t.snippet })),
  ];
}

const PROBE_SCRIPT = `
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const { pattern, texts, probes } = JSON.parse(s);
  let re;
  try { re = new RegExp(pattern, "i"); } catch (e) { process.stdout.write(JSON.stringify({ error: String(e.message) })); return; }
  for (const p of probes) re.test(p); // adversarial inputs: only their run time matters (the parent's timeout)
  const hits = [];
  texts.forEach((t, i) => { if (re.test(t)) hits.push(i); });
  process.stdout.write(JSON.stringify({ hits }));
});`;

/**
 * Long runs that end in a mismatch, the input shape that makes a catastrophic regex backtrack exponentially: a few
 * generic characters plus the pattern's own letters and digits, each repeated 64 times and followed by "!".
 */
export function adversarialProbes(pattern: string): string[] {
  const chars = new Set(["a", "q", "x", "0", " ", "\t", "_", "."]);
  for (const c of pattern.replace(/\\./g, "").match(/[a-z0-9]/gi) ?? []) if (chars.size < 24) chars.add(c);
  return [...chars].flatMap((c) => [`${c.repeat(64)}!`, `${(c + " ").repeat(32)}!`]);
}

const UNBOUNDED_QUANT = /^(?:[+*]|\{\d+,\})/;
const REPEAT_QUANT = /^(?:[+*]|\{\d*,\d*\}|\{\d+\})/;
const OVERLAP = "overlapping alternatives inside a repeated group (catastrophic backtracking)";

/**
 * Static ReDoS screen. Rejects an unboundedly repeated group that itself holds a repeat quantifier (`([a-z]+)+`,
 * `(q+q+)+`, `(\w+\s?)+`) or overlapping alternatives (one literal branch a prefix of another, as in `(a|aa)+`, or two
 * branches built from character classes, as in `(\w|\d)+`). Null when no such shape is found; the child-process probe
 * with adversarial inputs and a timeout runs after this for anything the screen cannot see.
 */
export function redosRisk(pattern: string): string | null {
  type Group = { repeats: boolean; branches: string[]; classy: boolean[] };
  const open = (): Group => ({ repeats: false, branches: [""], classy: [false] });
  const stack: Group[] = [open()];
  const top = (): Group => stack[stack.length - 1]!;
  const add = (text: string, classy: boolean): void => {
    const g = top();
    g.branches[g.branches.length - 1] += text;
    if (classy) g.classy[g.classy.length - 1] = true;
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    const rest = pattern.slice(i + 1);
    const q = REPEAT_QUANT.exec(pattern.slice(i))?.[0];
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      add(next, /[wdsWDS1-9]/.test(next));
      i++;
    } else if (ch === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      add("[]", true);
      i = j;
    } else if (ch === "(") {
      stack.push(open());
      const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_]\w*>)/.exec(rest);
      if (m) i += m[0].length;
    } else if (ch === ")") {
      if (stack.length < 2) return null; // unbalanced: the compile step reports it
      const g = stack.pop()!;
      if (UNBOUNDED_QUANT.test(rest)) {
        if (g.repeats) return "nested quantifier: a repeated group holds a repeat quantifier (catastrophic backtracking)";
        if (g.branches.length > 1) {
          if (g.classy.filter(Boolean).length >= 2) return OVERLAP;
          const lits = g.branches.map((b, k) => (g.classy[k] ? null : b.toLowerCase()));
          for (const [x, a] of lits.entries()) {
            for (const [y, b] of lits.entries()) if (x !== y && a !== null && b !== null && b.startsWith(a)) return OVERLAP;
          }
        }
      }
      const gq = REPEAT_QUANT.exec(rest)?.[0] ?? "";
      if (g.repeats || gq) top().repeats = true;
      add("()", true);
      i += gq.length;
    } else if (ch === "|") {
      top().branches.push("");
      top().classy.push(false);
    } else if (q) {
      top().repeats = true;
      i += q.length - 1;
    } else if (ch !== "?" && ch !== "^" && ch !== "$") {
      add(ch, ch === ".");
    }
  }
  return null;
}

/**
 * Screens `pattern` statically (redosRisk), then compiles it with the i flag in a child process that runs it on
 * adversarial inputs and then on the corpus under a timeout, so a catastrophic regex cannot hang the job. Null when safe.
 */
export function probeStaticRule(pattern: string, corpus: Array<{ name: string; text: string }>, timeoutMs = PROBE_TIMEOUT_MS): string | null {
  const risk = redosRisk(pattern);
  if (risk) return risk;
  const r = spawnSync(process.execPath, ["-e", PROBE_SCRIPT], {
    input: JSON.stringify({ pattern, texts: corpus.map((c) => c.text), probes: adversarialProbes(pattern) }),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    return r.signal || (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
      ? `regex probe timed out after ${timeoutMs} ms (catastrophic backtracking)`
      : `regex probe failed: ${r.stderr || r.error?.message}`;
  }
  const out = JSON.parse(r.stdout) as { error?: string; hits?: number[] };
  if (out.error) return `does not compile: ${out.error}`;
  if (out.hits?.length) return `matches ${out.hits.map((i) => corpus[i]!.name).slice(0, 5).join(", ")}`;
  return null;
}

const GLSL_RE = /#version|\bgl_Frag|\bvoid\s+main\s*\(|\b(?:vec[234]|mat[234]|float)\s+\w+\s*[(=;,]|\buniform\s+\w/;

/** The snippet inside a minimal piece: GLSL as a shader script (not JS), anything else as a module script. */
export function wrapSnippet(snippet: string): string {
  const script = GLSL_RE.test(snippet) ? `<script type="x-shader/x-fragment">\n${snippet}\n</script>` : `<script type="module">\n${snippet}\n</script>`;
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>snippet</title></head><body><canvas></canvas>\n${script}\n</body></html>\n`;
}

/** Lint errors for a snippet wrapped as a piece, or [] when it would pass. */
export function lintSnippet(snippet: string, slopRules: SlopRule[]): string[] {
  const r = lintPieceHtml(wrapSnippet(snippet), { sizeBudgetBytes: SNIPPET_BUDGET, constraint: null, slopRules, requireCsp: false });
  return r.passed ? [] : r.violations.map((v) => `${v.rule}: ${v.detail}`);
}

// ---------- render ----------

function meta(repoRoot: string, date: string): Meta | null {
  const p = join(repoRoot, "site", "pieces", date, "meta.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Meta) : null;
}

export function renderRetroPrompt(o: { weekEnding: string; outputPath: string; repoRoot?: string; ledger?: LedgerEntry[]; usagePath?: string }): string {
  const repoRoot = o.repoRoot ?? ROOT;
  const ledger = o.ledger ?? readLedger(join(repoRoot, "ledger", "ledger.jsonl"), repoRoot);
  const th = loadThresholds(repoRoot);
  const week = lastDays(ledger, o.weekEnding, 7)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => {
      const m = meta(repoRoot, e.date);
      return {
        date: e.date,
        status: e.status,
        score: e.score,
        compo: e.compo,
        domain: e.domain,
        technique_family: e.technique_family,
        concept: e.concept,
        reason: m?.reason ?? null,
        attempts: (m?.attempts ?? []).map((a) => ({
          attempt: a.attempt,
          model: a.model,
          outcome: a.outcome,
          gate_failures: a.gates?.failures.map((f) => f.gate) ?? [],
          total: a.verdict?.total ?? null,
          critique: a.verdict?.critique ?? null,
          scores: a.verdict?.scores ?? null,
        })),
      };
    });
  const tail = ledger
    .filter((e) => dayNumber(e.date) <= dayNumber(o.weekEnding))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30)
    .map(({ date, status, compo, domain, techniques, technique_family, palette, score }) => ({ date, status, compo, domain, techniques, technique_family, palette, score }));
  const alerts = computeUsageAlerts(readUsage(o.usagePath ?? join(repoRoot, "audit", "usage.jsonl"), repoRoot), th.usage, { endDate: o.weekEnding });
  const cfg = (f: string): string => readFileSync(join(repoRoot, "config", f), "utf8").trimEnd();
  return renderPrompt(
    readFileSync(join(repoRoot, "prompts", "retro.md"), "utf8"),
    {
      WEEK_ENDING: o.weekEnding,
      WEEK_VERDICTS_JSON: JSON.stringify(week, null, 1),
      LEDGER_TAIL_JSON: JSON.stringify(tail, null, 1),
      USAGE_REPORT_JSON: JSON.stringify({ alerts }, null, 1),
      CURRENT_SLOP_YML: cfg("slop.yml"),
      CURRENT_CURRICULUM_YML: cfg("curriculum.yml"),
      CURRENT_THRESHOLDS_YML: cfg("thresholds.yml"),
      COMPUTED_RATCHET_JSON: JSON.stringify({
        current_publish_min: th.publish_min,
        median_30d: median30d(ledger, o.weekEnding),
        publish_min: computeRatchetedThreshold(ledger, th, o.weekEnding),
      }),
      OUTPUT_PATH: o.outputPath,
    },
    { escapeHtmlLtKeys: ["WEEK_VERDICTS_JSON", "LEDGER_TAIL_JSON"] },
  );
}

// ---------- apply ----------

function seq(doc: Document, key: string): YAMLSeq {
  const s = doc.get(key, true) as YAMLSeq | undefined;
  if (!s || !Array.isArray(s.items)) throw new Error(`config has no '${key}' list`);
  return s;
}

export function applyRetro(o: ApplyOptions): ApplyReport {
  const repoRoot = o.repoRoot ?? ROOT;
  const configRoot = o.configRoot ?? repoRoot;
  const report: ApplyReport = {
    ok: false,
    errors: [],
    week_ending: null,
    applied: { slop_static: [], slop_visual: [], curriculum: [], publish_min: null },
    rejected: [],
    threshold: { previous: 0, median_30d: null, computed: 0, model_applied: null },
    usage_alerts: [],
  };
  const v = validateSchema("retro", o.retro, repoRoot);
  if (!v.ok) {
    report.errors = v.errors;
    return report;
  }
  const retro = o.retro as Retro;
  const weekEnding = o.weekEnding ?? retro.week_ending;
  report.week_ending = weekEnding;
  if (o.weekEnding && retro.week_ending !== o.weekEnding) report.errors.push(`week_ending ${retro.week_ending} is not ${o.weekEnding}; used ${o.weekEnding}`);

  const ledger = o.ledger ?? readLedger(join(repoRoot, "ledger", "ledger.jsonl"), repoRoot);
  const slop = loadSlop(configRoot);
  const curriculum = loadCurriculum(configRoot);
  const th = loadThresholds(configRoot);

  // Slop.
  const slopIds = new Set([...slop.static_rules.map((r) => r.id), ...slop.visual_slop.map((r) => r.id)]);
  const corpus = probeCorpus(repoRoot, configRoot);
  const newStatic: SlopRule[] = [];
  const newVisual: Array<{ id: string; description: string }> = [];
  for (const s of retro.slop_additions) {
    const reject = (reason: string): void => void report.rejected.push({ kind: "slop", id: s.id, reason });
    if (slopIds.has(s.id)) {
      reject("id already used in config/slop.yml or earlier in this batch");
      continue;
    }
    if (s.pattern_type === "static") {
      const why = probeStaticRule(s.pattern, corpus);
      if (why) {
        reject(why);
        continue;
      }
      newStatic.push({ id: s.id, pattern: s.pattern, flags: "i", message: s.rationale });
    } else {
      newVisual.push({ id: s.id, description: s.pattern });
    }
    slopIds.add(s.id);
  }

  // Curriculum. Snippets are linted against the old and the new static rules together.
  const rules = [...slop.static_rules, ...newStatic];
  const techIds = new Set([...curriculum.map((t) => t.id), ...ledger.flatMap((e) => e.techniques)]);
  const newTech: Retro["curriculum_additions"] = [];
  for (const t of retro.curriculum_additions) {
    const reject = (reason: string): void => void report.rejected.push({ kind: "curriculum", id: t.id, reason });
    if (techIds.has(t.id)) {
      reject("id already used in config/curriculum.yml, the ledger or earlier in this batch");
      continue;
    }
    const lint = lintSnippet(t.snippet, rules);
    if (lint.length) {
      reject(`snippet fails the piece lint: ${lint.slice(0, 3).join("; ")}`);
      continue;
    }
    newTech.push(t);
    techIds.add(t.id);
  }

  // Threshold and alerts: recomputed, never copied from the model.
  const computed = computeRatchetedThreshold(ledger, th, weekEnding);
  report.threshold = {
    previous: th.publish_min,
    median_30d: median30d(ledger, weekEnding),
    computed,
    model_applied: retro.threshold_recommendation.applied,
  };
  report.usage_alerts = computeUsageAlerts(readUsage(o.usagePath ?? join(repoRoot, "audit", "usage.jsonl"), repoRoot), th.usage, { endDate: weekEnding });

  // Write, keeping comments; reload; restore everything on any failure.
  const paths = { slop: join(configRoot, "config", "slop.yml"), curriculum: join(configRoot, "config", "curriculum.yml"), thresholds: join(configRoot, "config", "thresholds.yml") };
  const before = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, readFileSync(p, "utf8")])) as Record<keyof typeof paths, string>;
  const next = { ...before };
  if (newStatic.length || newVisual.length) {
    const doc = parseDocument(before.slop);
    for (const r of newStatic) seq(doc, "static_rules").add(doc.createNode(r));
    for (const r of newVisual) seq(doc, "visual_slop").add(doc.createNode(r));
    next.slop = doc.toString();
  }
  if (newTech.length) {
    const doc = parseDocument(before.curriculum);
    for (const t of newTech) seq(doc, "techniques").add(doc.createNode({ id: t.id, name: t.name, family: t.family, how_to: t.how_to, snippet: t.snippet }));
    next.curriculum = doc.toString();
  }
  if (computed !== th.publish_min) {
    const doc = parseDocument(before.thresholds);
    doc.set("publish_min", computed);
    next.thresholds = doc.toString();
  }
  if (!o.dryRun) {
    try {
      for (const k of Object.keys(paths) as Array<keyof typeof paths>) if (next[k] !== before[k]) writeFileSync(paths[k], next[k]);
      const s = loadSlop(configRoot);
      const c = loadCurriculum(configRoot);
      const t = loadThresholds(configRoot);
      if (s.static_rules.length !== slop.static_rules.length + newStatic.length) throw new Error("slop.yml reload count mismatch");
      if (c.length !== curriculum.length + newTech.length) throw new Error("curriculum.yml reload count mismatch");
      if (t.publish_min !== computed) throw new Error("thresholds.yml reload mismatch");
    } catch (e) {
      for (const k of Object.keys(paths) as Array<keyof typeof paths>) writeFileSync(paths[k], before[k]);
      report.errors.push(`config self-check failed, nothing applied: ${(e as Error).message}`);
      return report;
    }
  }
  report.applied = {
    slop_static: newStatic.map((r) => r.id),
    slop_visual: newVisual.map((r) => r.id),
    curriculum: newTech.map((t) => t.id),
    publish_min: computed !== th.publish_min ? { from: th.publish_min, to: computed } : null,
  };
  report.ok = true;
  return report;
}

// ---------- CLI ----------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: o, positionals: [cmd] } = parseArgs({
    allowPositionals: true,
    options: {
      "week-ending": { type: "string" },
      dir: { type: "string" },
      input: { type: "string" },
      report: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  try {
    if (cmd === "render") {
      const week = o["week-ending"] ?? new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error("--week-ending must be YYYY-MM-DD");
      if (!o.dir) throw new Error("render needs --dir");
      const dir = resolve(o.dir);
      const prompt = renderRetroPrompt({ weekEnding: week, outputPath: join(dir, "retro.json") });
      writeFileSync(join(dir, "prompt.md"), prompt);
      process.stdout.write(`${JSON.stringify({ prompt_file: join(dir, "prompt.md"), output: join(dir, "retro.json") })}\n`);
    } else if (cmd === "apply") {
      if (!o.input) throw new Error("apply needs --input");
      let retro: unknown = null;
      try {
        retro = JSON.parse(readFileSync(o.input, "utf8"));
      } catch (e) {
        retro = { invalid: (e as Error).message };
      }
      const report = applyRetro({ retro, ...(o["week-ending"] ? { weekEnding: o["week-ending"] } : {}), dryRun: o["dry-run"] ?? false });
      if (o.report) writeFileSync(o.report, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    } else {
      throw new Error("usage: retro-apply.ts render --week-ending D --dir DIR | apply --input F [--week-ending D] [--report P] [--dry-run]");
    }
  } catch (e) {
    process.stderr.write(`retro-apply: ${(e as Error).message}\n`);
    process.exitCode = 2;
  }
}
