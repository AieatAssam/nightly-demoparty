// Loads and shape-checks config/*.yml. A malformed config throws with the offending path.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { COMPO_IDS } from "./types.js";
import type {
  CompoConfig,
  CurriculumTechnique,
  DomainConfig,
  RepoConfig,
  SlopConfig,
  ThresholdsConfig,
} from "./types.js";

/** Walks up from `start` (default: this module's folder, then cwd) to the folder holding `schemas/`. */
export function findRepoRoot(start?: string): string {
  const starts = start ? [resolve(start)] : [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const s of starts) {
    let dir = s;
    for (;;) {
      if (existsSync(join(dir, "schemas", "plan.schema.json"))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error(`Cannot find repo root (a folder containing schemas/) from ${starts.join(", ")}`);
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${path}: expected an object`);
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${path}: expected an array`);
  return v;
}
function str(o: Obj, k: string, path: string): string {
  if (typeof o[k] !== "string") throw new Error(`${path}.${k}: expected a string`);
  return o[k] as string;
}
function num(o: Obj, k: string, path: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${path}.${k}: expected a number`);
  return v;
}
function bool(o: Obj, k: string, path: string): boolean {
  if (typeof o[k] !== "boolean") throw new Error(`${path}.${k}: expected a boolean`);
  return o[k] as boolean;
}
function nums<K extends string>(v: unknown, keys: readonly K[], path: string): Record<K, number> {
  const o = obj(v, path);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = num(o, k, path);
  return out;
}

function readYaml(repoRoot: string, file: string): unknown {
  const p = join(repoRoot, "config", file);
  return parse(readFileSync(p, "utf8"));
}

export function loadCompos(repoRoot: string): CompoConfig[] {
  const root = obj(readYaml(repoRoot, "compos.yml"), "compos.yml");
  return arr(root.compos, "compos.yml.compos").map((raw, i) => {
    const path = `compos.yml.compos[${i}]`;
    const o = obj(raw, path);
    const id = str(o, "id", path);
    if (!(COMPO_IDS as readonly string[]).includes(id)) throw new Error(`${path}.id: unknown compo '${id}'`);
    const c: CompoConfig = {
      id: id as CompoConfig["id"],
      label: str(o, "label", path),
      size_budget_bytes: num(o, "size_budget_bytes", path),
      requires_audio: bool(o, "requires_audio", path),
      notes: str(o, "notes", path),
    };
    if (o.constraints !== undefined && o.constraints !== null) {
      c.constraints = arr(o.constraints, `${path}.constraints`).map((rc, j) => {
        const cp = `${path}.constraints[${j}]`;
        const co = obj(rc, cp);
        return {
          id: str(co, "id", cp),
          label: str(co, "label", cp),
          size_budget_bytes: num(co, "size_budget_bytes", cp),
          rule: str(co, "rule", cp),
        };
      });
    }
    return c;
  });
}

export function loadDomains(repoRoot: string): DomainConfig[] {
  const root = obj(readYaml(repoRoot, "domains.yml"), "domains.yml");
  return arr(root.domains, "domains.yml.domains").map((raw, i) => {
    const path = `domains.yml.domains[${i}]`;
    const o = obj(raw, path);
    return {
      id: str(o, "id", path),
      name: str(o, "name", path),
      category: str(o, "category", path),
      weight: num(o, "weight", path),
      prompt_hint: str(o, "prompt_hint", path),
    };
  });
}

export function loadCurriculum(repoRoot: string): CurriculumTechnique[] {
  const root = obj(readYaml(repoRoot, "curriculum.yml"), "curriculum.yml");
  return arr(root.techniques, "curriculum.yml.techniques").map((raw, i) => {
    const path = `curriculum.yml.techniques[${i}]`;
    const o = obj(raw, path);
    return {
      id: str(o, "id", path),
      name: str(o, "name", path),
      family: str(o, "family", path),
      how_to: str(o, "how_to", path),
      snippet: str(o, "snippet", path),
    };
  });
}

export function loadThresholds(repoRoot: string): ThresholdsConfig {
  const p = "thresholds.yml";
  const o = obj(readYaml(repoRoot, p), p);
  return {
    publish_min: num(o, "publish_min", p),
    b_side_min: num(o, "b_side_min", p),
    ratchet_cap: num(o, "ratchet_cap", p),
    ratchet_median_offset: num(o, "ratchet_median_offset", p),
    novelty_a: nums(
      o.novelty_a,
      [
        "technique_jaccard_max",
        "concept_shingle_max",
        "palette_min_delta_e",
        "technique_window_nights",
        "palette_window_nights",
        "domain_window_nights",
        "compo_recency_window_nights",
        "boredom_window_nights",
        "wildcard_every_n_nights",
      ] as const,
      `${p}.novelty_a`,
    ),
    novelty_b: nums(
      o.novelty_b,
      ["phash_min_hamming", "histogram_min_distance", "histogram_window_nights"] as const,
      `${p}.novelty_b`,
    ),
    gates: nums(
      o.gates,
      [
        "luminance_variance_min",
        "frame_diff_min",
        "development_diff_min",
        "max_flashes_per_sec",
        "frame_time_median_budget_ms",
        "audio_rms_min",
        "audio_peak_max",
        "audio_clipped_ratio_max",
        "reduced_motion_ratio_max",
        "reduced_motion_abs_max",
        "dossier_max_bytes",
        "liner_note_max_words",
      ] as const,
      `${p}.gates`,
    ),
    usage: nums(o.usage, ["rolling_window_nights", "alert_growth_pct"] as const, `${p}.usage`),
  };
}

export function loadSlop(repoRoot: string): SlopConfig {
  const p = "slop.yml";
  const root = obj(readYaml(repoRoot, p), p);
  const static_rules = arr(root.static_rules, `${p}.static_rules`).map((raw, i) => {
    const path = `${p}.static_rules[${i}]`;
    const o = obj(raw, path);
    const rule = { id: str(o, "id", path), pattern: str(o, "pattern", path), message: str(o, "message", path) };
    const flags = o.flags === undefined || o.flags === null ? undefined : str(o, "flags", path);
    try {
      new RegExp(rule.pattern, flags); // fail fast on a bad regex
    } catch (e) {
      throw new Error(`${path}.pattern: invalid regex: ${(e as Error).message}`);
    }
    return flags === undefined ? rule : { ...rule, flags };
  });
  const visual_slop = arr(root.visual_slop, `${p}.visual_slop`).map((raw, i) => {
    const path = `${p}.visual_slop[${i}]`;
    const o = obj(raw, path);
    return { id: str(o, "id", path), description: str(o, "description", path) };
  });
  return { static_rules, visual_slop };
}

export function loadAllConfig(repoRoot?: string): RepoConfig {
  const root = repoRoot ? resolve(repoRoot) : findRepoRoot();
  return {
    repoRoot: root,
    compos: loadCompos(root),
    domains: loadDomains(root),
    curriculum: loadCurriculum(root),
    thresholds: loadThresholds(root),
    slop: loadSlop(root),
  };
}
