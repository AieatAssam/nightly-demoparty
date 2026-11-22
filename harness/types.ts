// Shared TypeScript shapes. Each JSON shape mirrors a file in schemas/ exactly;
// the schema is the source of truth and every write is validated against it.

export type SchemaName =
  | "appraisals"
  | "brief"
  | "dossier"
  | "gates"
  | "ledger-entry"
  | "meta"
  | "mood"
  | "plan"
  | "retro"
  | "usage-entry"
  | "verdict";

export const SCHEMA_NAMES: readonly SchemaName[] = [
  "appraisals",
  "brief",
  "dossier",
  "gates",
  "ledger-entry",
  "meta",
  "mood",
  "plan",
  "retro",
  "usage-entry",
  "verdict",
];

export type CompoId =
  | "4k-shader"
  | "16k-demo"
  | "audiovisual"
  | "interactive-toy"
  | "data-sculpture"
  | "kinetic-type"
  | "simulation"
  | "constraint-night";

export const COMPO_IDS: readonly CompoId[] = [
  "4k-shader",
  "16k-demo",
  "audiovisual",
  "interactive-toy",
  "data-sculpture",
  "kinetic-type",
  "simulation",
  "constraint-night",
];

export type EmotionLabel =
  | "joy"
  | "distress"
  | "hope"
  | "fear"
  | "relief"
  | "disappointment"
  | "pride"
  | "shame"
  | "admiration"
  | "reproach"
  | "gratitude"
  | "anger"
  | "interest"
  | "boredom"
  | "surprise";

export type NightStatus = "published" | "b-side" | "shelved";

// ---------- plan.schema.json ----------
export interface Plan {
  date: string;
  compo: CompoId;
  size_budget_bytes: number;
  constraint: string | null;
  domain: string;
  wildcard: boolean;
  banned: {
    techniques: string[];
    domains: string[];
    palette_hexes: string[];
    slop_patterns: string[];
  };
  boredom_override: boolean;
  requires_audio: boolean;
  seed: string | number;
  dry_run: boolean;
  overrides: {
    domain: string | null;
    compo: CompoId | null;
    mood_preset: string | null;
  };
}

// ---------- dossier.schema.json ----------
export interface DossierDataset {
  description: string;
  source_url: string;
  columns: string[];
  rows: Array<Array<number | string | null>>;
}

export interface Dossier {
  topic: string;
  domain: string;
  wildcard_chosen: boolean;
  summary: string;
  facts: Array<{ claim: string; source_url: string; source_title: string }>;
  visualisable_mechanisms: Array<{ name: string; description: string; render_or_sonify_hint: string }>;
  open_questions: string[];
  surprise: { score: number; justification: string };
  dataset?: DossierDataset | null;
}

// ---------- appraisals.schema.json ----------
export interface AppraisalEvent {
  event: string;
  event_id?: string;
  topics?: string[];
  relevance?: number;
  congruence?: number;
  novelty?: number;
  agency?: "self" | "other" | "circumstance";
  praiseworthiness?: number;
  control?: number;
  certainty?: number;
  source?: string;
  thread?: string;
  relationship?: { type: "romantic"; affection?: number; trust_violation?: number };
  perceived_emotion?: { label: EmotionLabel; intensity: number };
}

export interface Appraisals {
  events: AppraisalEvent[];
}

// ---------- mood.schema.json ----------
export interface Pad {
  pleasure: number;
  arousal: number;
  dominance: number;
}

export interface TopicScore {
  topic: string;
  score: number;
}

export interface Mood {
  timestamp: string;
  preset_override: string | null;
  dominant_emotions: Array<{ label: EmotionLabel; intensity: number }>;
  pad: Pad;
  neurochemistry: {
    dopamine: number;
    noradrenaline: number;
    serotonin: number;
    cortisol: number;
    oxytocin: number;
    opioids: number;
  };
  drives: { novelty: number; social: number; fatigue: number };
  derived_signals: { interest: number; boredom: number; frustration: number };
  likes: TopicScore[];
  dislikes: TopicScore[];
  creative_parameters: {
    tempo_density_cut_rate: { level: "low" | "medium" | "high"; value: number; guidance: string };
    palette_warmth_consonance_symmetry: {
      level: "cool-dissonant" | "balanced" | "warm-consonant";
      value: number;
      guidance: string;
    };
    scale_contrast_camera: { level: "intimate" | "measured" | "assertive"; value: number; guidance: string };
    technical_risk_budget: { level: "conservative" | "moderate" | "experimental"; value: number; guidance: string };
    boredom_force_unused_30d: boolean;
    frustration_scope_polish_weight: { shrink_scope: boolean; polish_weight_boost: number; guidance: string };
  };
}

// ---------- brief.schema.json ----------
export interface StoryboardBeat {
  beat: number;
  t_start_s: number;
  t_end_s: number;
  description: string;
}

export interface Brief {
  title: string;
  concept: string;
  mechanism_embodied: { mechanism_name: string; how_visualised: string };
  discarded_obvious_idea: string;
  compo: CompoId;
  constraint_honoured: string | null;
  techniques: string[];
  novel_technique: string;
  technique_family: string;
  palette: string[];
  motion_sound_plan: string;
  storyboard: StoryboardBeat[];
  memorable_moment: string;
  self_declared_risk: string;
  liner_note: string;
}

// ---------- gates.schema.json ----------
export interface Phashes {
  t2: string;
  t8: string;
  t20: string;
}

export interface Screenshots {
  t2: string;
  t8: string;
  t20: string;
}

export type GateName =
  | "size"
  | "lint"
  | "console"
  | "network"
  | "luminance"
  | "motion"
  | "development"
  | "strobe"
  | "frame_time"
  | "audio_autoplay"
  | "audio_probe"
  | "novelty_phash"
  | "novelty_histogram"
  | "reduced_motion";

export interface GateFailure {
  gate: GateName;
  message: string;
  measured?: number | string;
  threshold?: number | string;
}

export interface NoveltyBResult {
  phashes: Phashes;
  color_histogram: number[];
  min_hamming_distance: number | null;
  min_histogram_distance: number | null;
  closest_date: string | null;
  passed: boolean;
}

export interface SlopViolation {
  rule: string;
  detail: string;
}

export interface GatesResult {
  passed: boolean;
  piece_path: string;
  compo: CompoId;
  byte_size: number;
  size_budget_bytes: number;
  console_errors: string[];
  network_requests: string[];
  luminance_variance: { t2: number; t8: number; t20: number; floor: number; passed: boolean };
  motion: {
    frame_diff_mean: number;
    frame_diff_floor: number;
    development_diff_t2_t20: number;
    development_floor: number;
    passed: boolean;
  };
  strobe: { max_flashes_per_sec: number; limit: number; passed: boolean };
  frame_time_ms: { median: number; p90: number; budget_ms: number; passed: boolean };
  audio_probe: {
    required: boolean;
    autoplayed: boolean;
    rms: number;
    peak: number;
    clipped_ratio: number;
    passed: boolean;
  } | null;
  novelty_b: NoveltyBResult;
  slop_lint: { passed: boolean; violations: SlopViolation[] };
  reduced_motion: { passed: boolean; normal_motion: number; reduced_motion: number; ratio: number };
  screenshots: Screenshots;
  failures: GateFailure[];
}

// ---------- verdict.schema.json ----------
export type RubricKey = "mechanism" | "ambition" | "craft" | "distinctness" | "polish";

export interface CritiqueItem {
  rank: 1 | 2 | 3;
  change: string;
  expected_gain: number;
}

export interface Verdict {
  scores: Record<RubricKey, number>;
  total: number;
  evidence: Record<RubricKey, string>;
  pairwise_beats_median: boolean;
  pairwise_median_ref: string | null;
  pairwise_justification: string;
  calibration_anchors_used: string[];
  critique: CritiqueItem[];
}

// ---------- meta.schema.json ----------
export type AttemptOutcome = "build_failed" | "gates_failed" | "below_threshold" | "pairwise_failed" | "passed";

export interface MetaAttempt {
  attempt: number;
  model: string;
  effort: string | null;
  gates: GatesResult | null;
  verdict: Verdict | null;
  outcome: AttemptOutcome;
}

export interface Meta {
  date: string;
  status: NightStatus;
  reason: string | null;
  publish_threshold: number;
  best_attempt: number | null;
  plan: Plan;
  dossier: Dossier | null;
  mood: Mood | null;
  brief: Brief | null;
  attempts: MetaAttempt[];
  liner_note: string | null;
  screenshots: Screenshots | null;
  piece_rel_path: string | null;
}

// ---------- ledger-entry.schema.json ----------
export interface LedgerEntry {
  date: string;
  status: NightStatus;
  compo: CompoId;
  domain: string;
  topic: string | null;
  concept: string | null;
  techniques: string[];
  technique_family: string | null;
  palette: string[];
  phashes: { t2: string | null; t8: string | null; t20: string | null };
  color_histogram: number[] | null;
  score: number | null;
  attempts: number;
  mood_pad: Pad | null;
  dominant_emotion: EmotionLabel | null;
}

// ---------- usage-entry.schema.json ----------
export type UsageStage = "research" | "appraise" | "brief" | "build" | "jury" | "retro";

export interface UsageEntry {
  timestamp: string;
  date: string;
  run_id: string;
  stage: UsageStage;
  attempt: number;
  model: string;
  effort: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  duration_ms: number;
  num_turns: number;
}

// ---------- retro.schema.json ----------
export interface UsageAlert {
  stage: UsageStage;
  prior_7d_avg: number;
  current_7d_avg: number;
  pct_change: number;
}

export interface Retro {
  week_ending: string;
  nights_reviewed: number;
  summary: string;
  slop_additions: Array<{ id: string; pattern_type: "static" | "visual"; pattern: string; rationale: string }>;
  curriculum_additions: Array<{ id: string; name: string; family: string; how_to: string; snippet: string }>;
  threshold_recommendation: { previous: number; median_30d: number | null; computed: number; applied: number };
  usage_alerts: UsageAlert[];
}

// ---------- config/*.yml ----------
export interface CompoConstraint {
  id: string;
  label: string;
  size_budget_bytes: number;
  rule: string;
}

export interface CompoConfig {
  id: CompoId;
  label: string;
  size_budget_bytes: number;
  requires_audio: boolean;
  notes: string;
  constraints?: CompoConstraint[];
}

export interface DomainConfig {
  id: string;
  name: string;
  category: string;
  weight: number;
  prompt_hint: string;
}

export interface CurriculumTechnique {
  id: string;
  name: string;
  family: string;
  how_to: string;
  snippet: string;
}

export interface ThresholdsConfig {
  publish_min: number;
  b_side_min: number;
  ratchet_cap: number;
  ratchet_median_offset: number;
  novelty_a: {
    technique_jaccard_max: number;
    concept_shingle_max: number;
    palette_min_delta_e: number;
    technique_window_nights: number;
    palette_window_nights: number;
    domain_window_nights: number;
    compo_recency_window_nights: number;
    boredom_window_nights: number;
    wildcard_every_n_nights: number;
  };
  novelty_b: {
    phash_min_hamming: number;
    histogram_min_distance: number;
    histogram_window_nights: number;
  };
  gates: {
    luminance_variance_min: number;
    frame_diff_min: number;
    development_diff_min: number;
    max_flashes_per_sec: number;
    frame_time_median_budget_ms: number;
    audio_rms_min: number;
    audio_peak_max: number;
    audio_clipped_ratio_max: number;
    reduced_motion_ratio_max: number;
    reduced_motion_abs_max: number;
    dossier_max_bytes: number;
    liner_note_max_words: number;
  };
  usage: {
    rolling_window_nights: number;
    alert_growth_pct: number;
  };
}

export interface SlopRule {
  id: string;
  pattern: string;
  flags?: string;
  message: string;
}

export interface SlopConfig {
  static_rules: SlopRule[];
  visual_slop: Array<{ id: string; description: string }>;
}

export interface RepoConfig {
  repoRoot: string;
  compos: CompoConfig[];
  domains: DomainConfig[];
  curriculum: CurriculumTechnique[];
  thresholds: ThresholdsConfig;
  slop: SlopConfig;
}

// ---------- module contracts ----------
export interface LintOptions {
  sizeBudgetBytes: number;
  /** plan.constraint (constraint id or label) on constraint-night, else null. */
  constraint?: string | null;
  /** config/slop.yml static_rules. Required so a caller cannot skip slop lint by omission; pass [] to skip. */
  slopRules: SlopRule[];
  /** true at publish: the canonical CSP meta must be present. Builder output may omit it. */
  requireCsp?: boolean;
}

export type LintCategory = "security" | "csp" | "size" | "constraint" | "slop";

/** `rule` is `<category>/<id>`; `{rule, detail}` drops straight into gates.slop_lint.violations. */
export interface LintResult {
  passed: boolean;
  byte_size: number;
  size_budget_bytes: number;
  size_ok: boolean;
  violations: SlopViolation[];
}

export interface RunGatesOptions {
  piecePath: string;
  compo: CompoId;
  sizeBudgetBytes?: number;
  requiresAudio?: boolean;
  constraint?: string | null;
  outDir: string;
  ledgerPath?: string;
  timingScale?: number;
  repoRoot?: string;
  /** Tonight's date; Novelty Gate B then compares only against earlier nights. */
  date?: string;
}

export type NoveltyAKind =
  | "technique_banned"
  | "technique_jaccard"
  | "novel_technique_not_novel"
  | "concept_similarity"
  | "palette_distance";

export interface NoveltyACollision {
  kind: NoveltyAKind;
  detail: string;
  against_date?: string;
}

export interface NoveltyAResult {
  passed: boolean;
  collisions: NoveltyACollision[];
}
