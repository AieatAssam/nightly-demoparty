// Harness CLI. Prints JSON to stdout; exit 0 on pass, 1 on a failed check, 2 on usage/runtime error.
//   plan     --date D [--seed S] [--ledger P] [--mood P] [--dry-run] [--domain X] [--compo C] [--mood-preset M] [--out P]
//   novelty  --brief P --plan P [--dossier P] [--ledger P]
//   lint     <piece.html> [--compo C | --budget N] [--constraint X] [--require-csp]
//   gate     <piece.html> --compo C --out DIR [--budget N] [--audio] [--constraint X] [--ledger P] [--timing-scale N] [--date D]
//   decide   --attempts P --current N [--threshold N] [--max N]   (threshold defaults to thresholds.yml publish_min)
//   ratchet  [--date D] [--ledger P]   (weekly: the new publish_min for thresholds.yml)
//   publish  --input P [--dry-run --out DIR]
//   usage    [--file P] [--end D] [--metric tokens|cost_usd]
//   validate <schema> <file.json|file.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findRepoRoot, loadAllConfig } from "./config.js";
import { computeRatchetedThreshold, decideAttempt, median30d } from "./decide.js";
import type { AttemptRecord } from "./decide.js";
import { lintPieceHtml } from "./lint.js";
import { checkNoveltyA, readLedger } from "./novelty.js";
import { buildPlan } from "./plan.js";
import { publishNight } from "./publish.js";
import type { PublishInput } from "./publish.js";
import { assertSchema, validateBriefStrict, validateDossierStrict, validateSchema, validateVerdictStrict } from "./schema.js";
import { computeUsageAlerts, readUsage } from "./usage.js";
import { COMPO_IDS, SCHEMA_NAMES } from "./types.js";
import type { Brief, CompoId, Dossier, Mood, Plan, SchemaName, Verdict } from "./types.js";

class UsageError extends Error {}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function need(v: string | undefined, flag: string): string {
  if (v === undefined || v === "") throw new UsageError(`missing --${flag}`);
  return v;
}

function int(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`--${flag} must be an integer`);
  return n;
}

function compoArg(v: string | undefined): CompoId | undefined {
  if (v === undefined) return undefined;
  if (!(COMPO_IDS as readonly string[]).includes(v)) throw new UsageError(`unknown compo '${v}'`);
  return v as CompoId;
}

function out(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values: o, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      date: { type: "string" },
      seed: { type: "string" },
      ledger: { type: "string" },
      mood: { type: "string" },
      "dry-run": { type: "boolean" },
      domain: { type: "string" },
      compo: { type: "string" },
      "mood-preset": { type: "string" },
      out: { type: "string" },
      brief: { type: "string" },
      plan: { type: "string" },
      dossier: { type: "string" },
      budget: { type: "string" },
      constraint: { type: "string" },
      "require-csp": { type: "boolean" },
      audio: { type: "boolean" },
      "timing-scale": { type: "string" },
      attempts: { type: "string" },
      current: { type: "string" },
      threshold: { type: "string" },
      max: { type: "string" },
      input: { type: "string" },
      file: { type: "string" },
      end: { type: "string" },
      metric: { type: "string" },
      "repo-root": { type: "string" },
    },
  });
  const repoRoot = o["repo-root"] ? resolve(o["repo-root"]) : findRepoRoot();
  const ledgerPath = o.ledger ?? join(repoRoot, "ledger", "ledger.jsonl");

  switch (cmd) {
    case "plan": {
      const config = loadAllConfig(repoRoot);
      const plan = buildPlan({
        date: need(o.date, "date"),
        config,
        ledger: readLedger(ledgerPath, repoRoot),
        mood: o.mood ? assertSchema<Mood>("mood", readJson(o.mood), repoRoot) : null,
        ...(o.seed !== undefined ? { seed: o.seed } : {}),
        dryRun: o["dry-run"] ?? false,
        overrides: { domain: o.domain ?? null, compo: compoArg(o.compo) ?? null, mood_preset: o["mood-preset"] ?? null },
      });
      if (o.out) writeFileSync(o.out, `${JSON.stringify(plan, null, 2)}\n`);
      out(plan);
      return 0;
    }
    case "novelty": {
      const config = loadAllConfig(repoRoot);
      const plan = assertSchema<Plan>("plan", readJson(need(o.plan, "plan")), repoRoot);
      const brief = readJson(need(o.brief, "brief")) as Brief;
      const dossier = o.dossier ? assertSchema<Dossier>("dossier", readJson(o.dossier), repoRoot) : null;
      const ledger = readLedger(ledgerPath, repoRoot);
      const strict = validateBriefStrict(brief, dossier, ledger, {
        plan,
        maxWords: config.thresholds.gates.liner_note_max_words,
        repoRoot,
      });
      const gate = strict.ok
        ? checkNoveltyA({ brief, plan, ledger, thresholds: config.thresholds.novelty_a })
        : { passed: false, collisions: [] };
      const passed = strict.ok && gate.passed;
      out({ passed, brief_errors: strict.ok ? [] : strict.errors, collisions: gate.collisions });
      return passed ? 0 : 1;
    }
    case "lint": {
      const piece = need(pos[0], "<piece.html>");
      const config = loadAllConfig(repoRoot);
      const compo = compoArg(o.compo);
      const budget = int(o.budget, "budget") ?? config.compos.find((c) => c.id === compo)?.size_budget_bytes;
      if (budget === undefined) throw new UsageError("lint needs --budget or --compo");
      const res = lintPieceHtml(readFileSync(piece, "utf8"), {
        sizeBudgetBytes: budget,
        constraint: o.constraint ?? null,
        slopRules: config.slop.static_rules,
        requireCsp: o["require-csp"] ?? false,
      });
      out(res);
      return res.passed ? 0 : 1;
    }
    case "gate": {
      const { runHardGates } = await import("./gates.js");
      const scale = o["timing-scale"] === undefined ? undefined : Number(o["timing-scale"]);
      const budget = int(o.budget, "budget");
      const res = await runHardGates({
        piecePath: need(pos[0], "<piece.html>"),
        compo: compoArg(need(o.compo, "compo"))!,
        outDir: need(o.out, "out"),
        ledgerPath,
        repoRoot,
        constraint: o.constraint ?? null,
        ...(o.date !== undefined ? { date: o.date } : {}),
        ...(budget !== undefined ? { sizeBudgetBytes: budget } : {}),
        ...(o.audio !== undefined ? { requiresAudio: o.audio } : {}),
        ...(scale !== undefined && Number.isFinite(scale) ? { timingScale: scale } : {}),
      });
      out(res);
      return res.passed ? 0 : 1;
    }
    case "decide": {
      const config = loadAllConfig(repoRoot);
      const attempts = readJson(need(o.attempts, "attempts")) as AttemptRecord[];
      if (!Array.isArray(attempts)) throw new UsageError("--attempts must be a JSON array of {attempt, gates, verdict}");
      for (const a of attempts) {
        if (a.gates) assertSchema("gates", a.gates, repoRoot);
        if (a.verdict) {
          const v = validateVerdictStrict(a.verdict, repoRoot);
          if (!v.ok) throw new Error(`attempt ${a.attempt} verdict invalid: ${v.errors.join("; ")}`);
        }
      }
      // publish_min is ratcheted weekly (the `ratchet` command), not recomputed every night.
      const publishThreshold = int(o.threshold, "threshold") ?? config.thresholds.publish_min;
      const res = decideAttempt({
        attempts,
        currentAttempt: int(need(o.current, "current"), "current")!,
        maxAttempts: int(o.max, "max") ?? 3,
        publishThreshold,
        bSideMin: config.thresholds.b_side_min,
      });
      out(res);
      return 0; // shelve is a correct outcome; the workflow branches on .action
    }
    case "ratchet": {
      const config = loadAllConfig(repoRoot);
      const ledger = readLedger(ledgerPath, repoRoot);
      out({
        current_publish_min: config.thresholds.publish_min,
        median_30d: median30d(ledger, o.date),
        publish_min: computeRatchetedThreshold(ledger, config.thresholds, o.date),
      });
      return 0;
    }
    case "publish": {
      const input = readJson(need(o.input, "input")) as PublishInput;
      const res = publishNight({
        ...input,
        repoRoot,
        dryRun: o["dry-run"] ?? input.dryRun ?? false,
        ...(o.out !== undefined ? { outputDir: o.out } : {}),
      });
      out(res);
      return 0;
    }
    case "usage": {
      const config = loadAllConfig(repoRoot);
      const metric = o.metric ?? "tokens";
      if (metric !== "tokens" && metric !== "cost_usd") throw new UsageError("--metric must be tokens or cost_usd");
      const alerts = computeUsageAlerts(readUsage(o.file ?? join(repoRoot, "audit", "usage.jsonl"), repoRoot), config.thresholds.usage, {
        metric,
        ...(o.end !== undefined ? { endDate: o.end } : {}),
      });
      out({ alerts });
      return 0; // alerts are data for the retro, not a failure
    }
    case "validate": {
      const schema = need(pos[0], "<schema>");
      const file = need(pos[1], "<file>");
      if (!(SCHEMA_NAMES as readonly string[]).includes(schema)) {
        throw new UsageError(`unknown schema '${schema}' (one of: ${SCHEMA_NAMES.join(", ")})`);
      }
      const text = readFileSync(file, "utf8");
      // Strict (harness-invariant) checks for the LLM-written stage outputs.
      if (schema === "dossier" || schema === "brief" || schema === "verdict") {
        const config = loadAllConfig(repoRoot);
        const plan = o.plan ? assertSchema<Plan>("plan", readJson(o.plan), repoRoot) : null;
        const r =
          schema === "dossier"
            ? validateDossierStrict(text, plan ?? undefined, { maxBytes: config.thresholds.gates.dossier_max_bytes, repoRoot })
            : schema === "brief"
              ? validateBriefStrict(
                  JSON.parse(text) as Brief,
                  o.dossier ? assertSchema<Dossier>("dossier", readJson(o.dossier), repoRoot) : null,
                  o.ledger ? readLedger(o.ledger, repoRoot) : null,
                  { plan, maxWords: config.thresholds.gates.liner_note_max_words, repoRoot },
                )
              : validateVerdictStrict(JSON.parse(text) as Verdict, repoRoot);
        const errors = r.ok ? [] : r.errors;
        out({ ok: r.ok, schema, file, strict: true, errors });
        return r.ok ? 0 : 1;
      }
      const docs = file.endsWith(".jsonl")
        ? text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown)
        : [JSON.parse(text) as unknown];
      const errors = docs.flatMap((d, i) => {
        const r = validateSchema(schema as SchemaName, d, repoRoot);
        return r.ok ? [] : r.errors.map((e) => (docs.length > 1 ? `line ${i + 1}: ${e}` : e));
      });
      out({ ok: errors.length === 0, schema, file, errors });
      return errors.length ? 1 : 0;
    }
    default:
      throw new UsageError(`unknown command '${cmd ?? ""}' (plan, novelty, lint, gate, decide, ratchet, publish, usage, validate)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      const err = e as Error;
      out({ error: err.message, usage: err instanceof UsageError });
      process.exit(2);
    },
  );
}
