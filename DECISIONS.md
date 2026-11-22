# Decisions

Build decisions that refine `SPEC.md`. Newest section last.

## Schema contract (Thread S1)

### Files

SPEC section 9 listed five schemas. The pipeline needs eleven, so six were added:

| File | Written by | Read by |
|------|------------|---------|
| `plan.schema.json` | Stage 0 `harness/plan` | stages 1 to 9 |
| `dossier.schema.json` | Stage 1 Research (Haiku) | stages 2, 3, 7, 9 |
| `appraisals.schema.json` | Stage 2 appraisal (Haiku) | `affect_core.py appraise --json -` |
| `mood.schema.json` | Stage 2 script | stages 3, 9 |
| `brief.schema.json` | Stage 3 Brief (Haiku) | stages 4, 5, 7, 9 |
| `gates.schema.json` | Stage 6 `harness/gates` | stages 5 (retry), 8, 9 |
| `verdict.schema.json` | Stage 7 Jury (Haiku) | stages 5 (retry), 8, 9 |
| `meta.schema.json` | Stage 9 publish | gallery build, audit |
| `ledger-entry.schema.json` | Stage 9, one line of `ledger/ledger.jsonl` | stage 0, novelty gates, retro |
| `usage-entry.schema.json` | `.github/actions/agent`, one line of `audit/usage.jsonl` | weekly retro |
| `retro.schema.json` | weekly retrospective (Opus, low effort) | `weekly.yml` config updates |

The added files are `plan`, `appraisals`, `meta`, `ledger-entry`, `usage-entry` and `retro`.

### Conventions

- **Draft 2020-12, Ajv strict.** Every schema sets `"$schema": "https://json-schema.org/draft/2020-12/schema"` and compiles under `new Ajv2020({ strict: true, allErrors: true })` with `ajv-formats`. Because they pass strict mode, they also pass any looser Ajv configuration.
- **`$id` and cross-file refs.** Every `$id` is `https://nightly-demoparty.invalid/schemas/<file>`. The `.invalid` TLD is reserved, so nothing tries to fetch it. Schemas point at each other with relative `$ref`s such as `plan.schema.json#/$defs/compo`. **A validator must `addSchema` all eleven files into one Ajv instance** before it calls `getSchema(<$id>)`. Compiling one file on its own fails on unresolved refs.
- **Shared definitions have one home each.** No schema duplicates an enum or pattern:
  - `plan.schema.json#/$defs/` holds `compo` (the 8 compos), `date` and `hexColor`.
  - `appraisals.schema.json#/$defs/emotionLabel` holds the 15 emotions.
  - `mood.schema.json#/$defs/pad` holds the PAD vector.
  - `gates.schema.json#/$defs/` holds `phash`, `screenshots` and `colorHistogram`.
  - `meta.schema.json#/$defs/status` holds the night status.
  - `usage-entry.schema.json#/$defs/stage` holds the stage name.
- **Closed objects.** Every object, nested ones included, sets `additionalProperties: false`, so an LLM that invents a key fails validation immediately.
- **Required plus nullable, not optional.** Every property is listed in `required`. A value that may be missing is typed as nullable (`"type": ["string", "null"]`, or `anyOf` with `{ "type": "null" }` for `$ref`s). The OpenAPI `nullable` keyword is not used. Only these properties may be omitted:
  - every appraisal field except `event`, which matches the agent-emotion-core CLI, where omitted fields take engine defaults;
  - `dossier.dataset`;
  - `relationship.affection` and `relationship.trust_violation` inside an appraisal `relationship`;
  - `gates.failures[].measured` and `gates.failures[].threshold`.
- **Conditionally non-null.** A field that must be non-null under some condition is written as an `if`/`then` in a top-level `allOf`. The `then` narrows the property's type and does not use `required`, which keeps strict mode happy. There are four conditions:
  - `plan.constraint` must be a string when `compo` is `constraint-night`.
  - `meta.reason` must be a string when `status` is `b-side` or `shelved`.
  - `meta.reason` must be null when `status` is `published`.
  - When `meta.status` is `published` or `b-side`, these must be non-null: `best_attempt`, `dossier`, `mood`, `brief`, `liner_note`, `screenshots` and `piece_rel_path`. `attempts` must also have at least one entry.
- **Exact-length arrays** use `minItems == maxItems` and never `prefixItems`:
  - `brief.storyboard`: 4
  - `verdict.critique`: 3
  - `verdict.calibration_anchors_used`: 4
  - `retro.curriculum_additions`: 3
- **Dates** use `format: "date"` together with the pattern `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`, so they are calendar-checked and also exactly `YYYY-MM-DD`. Timestamps use `format: "date-time"`.
- **Colours** are `^#[0-9A-Fa-f]{6}$`. Either case is accepted on input. The harness lowercases colours before it compares or stores them, so the ledger holds lowercase.
- **Perceptual hashes** are lowercase hex, 16 to 64 characters. 16 characters (64 bits) is the expected size.
- **Scores are integers.** The rubric criteria, `verdict.total`, `ledger.score` and the thresholds are all integers. `retro.threshold_recommendation.median_30d` and `verdict.critique[].expected_gain` stay plain numbers.
- **LLM-facing descriptions.** When an LLM-written schema (`brief`, `retro`) points at a shared definition in another file, the `description` next to that `$ref` repeats the format in words, so a prompt that embeds the schema on its own still tells the model what to write.
- **Untrusted dossier.** Every string in `dossier.schema.json` has a `maxLength` and every array has a `maxItems`, `dataset` included: at most 12 columns, at most 200 rows, column names and string cells limited to 40 characters, cells are strings, numbers or null. The harness also caps the whole serialized file (see below). Every URL must match `^https?://`.
- **Colour histograms** (`gates.novelty_b.color_histogram`, `ledger.color_histogram`) are exactly 64 bins: a normalised 4x4x4 RGB histogram over the three screenshots. Each channel is quantised to 0..3 (`value >> 6`), the bin index is `r * 16 + g * 4 + b`, and the bins sum to 1. The shape lives once in `gates.schema.json#/$defs/colorHistogram`.
- **Appraisal topics** are at most 8 tags of at most 60 characters, the limits inside `affect_core.py`, so the engine never truncates a tag silently.

### Shapes that were ambiguous and how they were resolved

- **`meta` for early-shelved nights.** `dossier`, `mood`, `brief`, `best_attempt`, `liner_note`, `screenshots` and `piece_rel_path` are nullable, so a night shelved before research, brief or render still writes valid metadata. `attempts[].gates` is null only for `outcome: build_failed`. `attempts[].verdict` is null whenever the jury did not run.
- **`meta.attempts[].outcome`** is one of `build_failed`, `gates_failed`, `below_threshold`, `pairwise_failed` or `passed`.
- **The ledger gets one row every night, shelved nights included.** For that reason `topic`, `concept`, `technique_family`, `color_histogram` and `score` are nullable, `techniques` and `palette` may be empty, and `attempts` ranges from 0 to 3, where 0 means the night was shelved before the build. `mood_pad` and `dominant_emotion` are null when stage 2 never ran. `phashes` is always an object, and each of its fields is nullable.
- **`meta.screenshots`** is nullable as a whole. When present, all three paths are present.
- **`plan.boredom_override`, `plan.requires_audio` and `plan.seed`** sit at the top level of the plan, not inside `banned`. `plan.domain` is the literal `wildcard` on wildcard nights. `dossier.domain` records the domain the researcher actually chose.
- **`usage-entry.stage`** covers only LLM stages: `research`, `appraise`, `brief`, `build`, `jury` and `retro`, matching `prompts/*.md`. For the retro, `date` is the `week_ending`.
- **`mood.drives`** is the agent-emotion-core `summary()` drives object verbatim: `novelty`, `social`, `fatigue`, each 0 to 1.
- **`mood.derived_signals`** holds the three signals SPEC stage 2 maps to creative parameters. The stage 2 script computes them; no LLM writes them:
  - `interest` = engine `emotions.interest`, copied.
  - `boredom` = engine `emotions.boredom`, copied.
  - `frustration` = `clamp01(0.5 * min(shelved_streak, 3) / 3 + 0.25 * cortisol + 0.25 * distress)`, where `shelved_streak` is the number of consecutive shelved nights immediately before tonight in the ledger, `cortisol` is `neurochemistry.cortisol` and `distress` is engine `emotions.distress` (0 if absent).
- **`mood.creative_parameters`** reads fixed fields: tempo from `pad.arousal` (value `(arousal + 1) / 2`), palette from `pad.pleasure`, scale from `pad.dominance`, risk budget from `derived_signals.interest`, the 30-night force from `derived_signals.boredom`, scope and polish from `derived_signals.frustration`.
- **`plan.dry_run` and `plan.overrides`** record the `workflow_dispatch` inputs. `overrides.domain`, `overrides.compo` and `overrides.mood_preset` are null when not forced; scheduled runs have `dry_run: false` and all three null.
- **`gates.failures[].gate`** is an enum: `size`, `lint`, `console`, `network`, `luminance`, `motion`, `development`, `strobe`, `frame_time`, `audio_autoplay`, `audio_probe`, `novelty_phash`, `novelty_histogram`, `reduced_motion`.
- **`liner_note`** allows 1000 characters in `brief` and `meta`; the real limit is 120 words, enforced by the harness.
- **`mood.likes[].score` and `mood.dislikes[].score`** pass the engine value through unbounded, because its scale belongs to agent-emotion-core.

### Rules the harness enforces (JSON Schema cannot express them)

- `brief.novel_technique` appears in `brief.techniques` and appears nowhere in the ledger.
- No `brief.techniques` entry is in `plan.banned.techniques`. `brief.compo` equals `plan.compo`.
- `brief.mechanism_embodied.mechanism_name` equals one of the `dossier.visualisable_mechanisms[].name` values.
- `brief.storyboard` beats are 1, 2, 3, 4 in order, each `t_start_s` is less than its `t_end_s`, and together they cover 0 to 20 s.
- `brief.liner_note` is at most 120 words.
- `verdict.total` equals the sum of `verdict.scores`. `verdict.critique` ranks are 1, 2, 3 with none repeated.
- The dossier cites at least 3 distinct source hosts. If it does not, research is re-run once (SPEC stage 1).
- `dossier.dataset` rows have exactly `columns.length` cells.
- `gates.passed` is the AND of every sub-gate `passed`, and `failures` is empty exactly when `passed` is true.
- Serialized `dossier.json` is at most 24576 bytes (24 KB). The harness checks this immediately after stage 1 and treats an oversized dossier as a failed research run.
- `plan.compo === "data-sculpture"` requires a non-null `dossier.dataset`.
- On night 1, or whenever the archive is empty (`pairwise_median_ref === null`), the pairwise comparison counts as a pass in stage 8 `decide`.
- Published and b-side nights need a non-null `verdict` on the best attempt (`attempts[best_attempt - 1].verdict`) and a non-null `ledger.score`.
- Each `meta.attempts[].outcome` matches what ran:
  - `build_failed`: `gates: null`, `verdict: null`.
  - `gates_failed`: `gates.passed === false`, `verdict: null`.
  - `below_threshold`: `gates.passed === true`, `verdict.total` below the publish threshold.
  - `pairwise_failed`: `gates.passed === true`, `verdict.total` at or above the threshold, `verdict.pairwise_beats_median === false` and non-null `verdict.pairwise_median_ref` (so it never happens on an empty archive).
  - `passed`: `gates.passed === true`, `verdict.total` at or above the threshold, and either `verdict.pairwise_beats_median === true` or `verdict.pairwise_median_ref === null`.
- Stage 6 `gates.ts` always runs every browser probe and never stops at the first failure, so `gates.json` holds every measurement and all screenshots even when an early check fails. The only exception is HTML that cannot load or render at all.
