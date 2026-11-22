// One Ajv2020 instance holding all eleven schemas (cross-file $refs need them together),
// plus the harness-level invariants from DECISIONS.md that JSON Schema cannot express.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { findRepoRoot } from "./config.js";
import { SCHEMA_NAMES } from "./types.js";
import type { Brief, Dossier, LedgerEntry, Plan, SchemaName, Verdict } from "./types.js";

// ajv-formats is CJS with `export default`; under NodeNext the default import is the module object.
type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats: AddFormats =
  (addFormatsImport as unknown as { default?: AddFormats }).default ?? (addFormatsImport as unknown as AddFormats);

export const SCHEMA_ID_BASE = "https://nightly-demoparty.invalid/schemas/";
export const DOSSIER_MAX_BYTES = 24576;
export const LINER_NOTE_MAX_WORDS = 120;

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

const instances = new Map<string, Ajv2020>();

export function getAjv(repoRoot?: string): Ajv2020 {
  const root = repoRoot ? resolve(repoRoot) : findRepoRoot();
  let ajv = instances.get(root);
  if (!ajv) {
    ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    for (const name of SCHEMA_NAMES) {
      ajv.addSchema(JSON.parse(readFileSync(join(root, "schemas", `${name}.schema.json`), "utf8")) as object);
    }
    instances.set(root, ajv);
  }
  return ajv;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"} ${JSON.stringify(e.params)}`);
}

export function validateSchema<T>(schemaName: SchemaName, data: unknown, repoRoot?: string): ValidationResult<T> {
  const validate = getAjv(repoRoot).getSchema(`${SCHEMA_ID_BASE}${schemaName}.schema.json`);
  if (!validate) throw new Error(`Unknown schema: ${schemaName}`);
  return validate(data) ? { ok: true, data: data as T } : { ok: false, errors: formatErrors(validate.errors) };
}

export function assertSchema<T>(schemaName: SchemaName, data: unknown, repoRoot?: string): T {
  const r = validateSchema<T>(schemaName, data, repoRoot);
  if (!r.ok) throw new Error(`${schemaName} schema validation failed:\n  ${r.errors.join("\n  ")}`);
  return r.data;
}

export function normTechnique(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Stage 1 check: byte cap, schema, >= 3 distinct source hosts, dataset shape, data-sculpture dataset. */
export function validateDossierStrict(
  rawJsonText: string,
  plan?: Plan,
  opts: { maxBytes?: number; repoRoot?: string } = {},
): ValidationResult<Dossier> {
  const maxBytes = opts.maxBytes ?? DOSSIER_MAX_BYTES;
  const bytes = Buffer.byteLength(rawJsonText, "utf8");
  if (bytes > maxBytes) return { ok: false, errors: [`dossier is ${bytes} bytes, over the ${maxBytes}-byte cap`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch (e) {
    return { ok: false, errors: [`dossier is not valid JSON: ${(e as Error).message}`] };
  }
  const r = validateSchema<Dossier>("dossier", parsed, opts.repoRoot);
  if (!r.ok) return r;
  const d = r.data;
  const errors: string[] = [];
  const hosts = new Set(d.facts.map((f) => hostOf(f.source_url)).filter((h): h is string => h !== null));
  if (hosts.size < 3) errors.push(`dossier cites ${hosts.size} distinct source host(s), needs at least 3`);
  if (d.dataset) {
    const n = d.dataset.columns.length;
    d.dataset.rows.forEach((row, i) => {
      if (row.length !== n) errors.push(`dataset.rows[${i}] has ${row.length} cells, expected ${n}`);
    });
  }
  if (plan?.compo === "data-sculpture" && !d.dataset) errors.push("data-sculpture night requires a non-null dossier.dataset");
  return errors.length ? { ok: false, errors } : { ok: true, data: d };
}

/** Stage 3 check: schema plus every brief invariant in DECISIONS.md that the inputs allow. */
export function validateBriefStrict(
  brief: Brief,
  dossier?: Dossier | null,
  ledger?: LedgerEntry[] | null,
  opts: { plan?: Plan | null; maxWords?: number; repoRoot?: string } = {},
): ValidationResult<Brief> {
  const r = validateSchema<Brief>("brief", brief, opts.repoRoot);
  if (!r.ok) return r;
  const b = r.data;
  const errors: string[] = [];
  const novel = normTechnique(b.novel_technique);
  if (!b.techniques.some((t) => normTechnique(t) === novel)) {
    errors.push(`novel_technique '${b.novel_technique}' is not listed in techniques`);
  }
  if (ledger) {
    const hit = ledger.find((e) => e.techniques.some((t) => normTechnique(t) === novel));
    if (hit) errors.push(`novel_technique '${b.novel_technique}' already appears in the ledger (${hit.date})`);
  }
  b.storyboard.forEach((beat, i) => {
    if (beat.beat !== i + 1) errors.push(`storyboard[${i}].beat is ${beat.beat}, expected ${i + 1}`);
    if (!(beat.t_start_s < beat.t_end_s)) errors.push(`storyboard[${i}] t_start_s must be < t_end_s`);
    if (i > 0) {
      const prev = b.storyboard[i - 1]!;
      if (beat.t_start_s > prev.t_end_s) errors.push(`storyboard gap between beat ${i} and beat ${i + 1}`);
      if (beat.t_start_s < prev.t_start_s) errors.push(`storyboard[${i}] starts before beat ${i}`);
    }
  });
  const first = b.storyboard[0];
  const last = b.storyboard[b.storyboard.length - 1];
  if (first && first.t_start_s !== 0) errors.push("storyboard must start at 0 s");
  if (last && last.t_end_s !== 20) errors.push("storyboard must end at 20 s");
  const maxWords = opts.maxWords ?? LINER_NOTE_MAX_WORDS;
  const words = wordCount(b.liner_note);
  if (words > maxWords) errors.push(`liner_note is ${words} words, over ${maxWords}`);
  if (dossier) {
    const name = b.mechanism_embodied.mechanism_name.trim();
    if (!dossier.visualisable_mechanisms.some((m) => m.name.trim() === name)) {
      errors.push(`mechanism_name '${name}' does not match any dossier.visualisable_mechanisms name`);
    }
  }
  const plan = opts.plan;
  if (plan) {
    if (b.compo !== plan.compo) errors.push(`brief.compo '${b.compo}' differs from plan.compo '${plan.compo}'`);
    const banned = new Set(plan.banned.techniques.map(normTechnique));
    for (const t of b.techniques) if (banned.has(normTechnique(t))) errors.push(`technique '${t}' is banned tonight`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, data: b };
}

/** Stage 7 check: schema, total equals the score sum, critique ranks are exactly 1, 2, 3. */
export function validateVerdictStrict(verdict: Verdict, repoRoot?: string): ValidationResult<Verdict> {
  const r = validateSchema<Verdict>("verdict", verdict, repoRoot);
  if (!r.ok) return r;
  const v = r.data;
  const errors: string[] = [];
  const sum = v.scores.mechanism + v.scores.ambition + v.scores.craft + v.scores.distinctness + v.scores.polish;
  if (v.total !== sum) errors.push(`total ${v.total} does not equal the score sum ${sum}`);
  const ranks = v.critique.map((c) => c.rank).sort((a, b) => a - b);
  if (ranks.join(",") !== "1,2,3") errors.push(`critique ranks must be 1, 2, 3 without repeats (got ${ranks.join(", ")})`);
  return errors.length ? { ok: false, errors } : { ok: true, data: v };
}
