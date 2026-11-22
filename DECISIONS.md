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
  - `below_threshold`: `gates.passed === true`, and `verdict.total` below the publish threshold or `verdict: null` (the jury produced no valid verdict).
  - `pairwise_failed`: `gates.passed === true`, `verdict.total` at or above the threshold, `verdict.pairwise_beats_median === false` and non-null `verdict.pairwise_median_ref` (so it never happens on an empty archive).
  - `passed`: `gates.passed === true`, `verdict.total` at or above the threshold, and either `verdict.pairwise_beats_median === true` or `verdict.pairwise_median_ref === null`.
- Stage 6 `gates.ts` always runs every browser probe and never stops at the first failure, so `gates.json` holds every measurement and all screenshots even when an early check fails. The only exception is HTML that cannot load or render at all.

## Milestone 1 review fixes (Threads 1R and 1D)

### Decide and ratchet

- **Pairwise fail at the attempt cap goes to B-side.** When the attempt cap is reached and the best attempt scored at or above the publish threshold but lost the pairwise check (`pairwise_failed`), the night is a B-side, not a shelve. SPEC says a pairwise loss "is a fail" for publishing; the piece still cleared the B-side floor, so it lands on the B-sides shelf with a reason naming the lost pairwise comparison. Below the threshold, the usual 60 to 71 B-side band and the below-60 shelve rule apply.
- **The 30-night median ignores shelved nights.** `median30d` (and so the ratchet) uses only `published` and `b-side` rows with a non-null `score` from the 30 calendar nights before the date. Shelved rows can carry a best-effort score; counting them would let a bad week lower the bar.
- **The ratchet runs weekly, not nightly.** `harness/cli.ts decide` reads `publish_min` from `config/thresholds.yml` (or `--threshold`). The weekly job runs `harness/cli.ts ratchet [--date D]`, which prints `min(ratchet_cap, max(72, floor(median_30d - ratchet_median_offset)))` (72 when nothing is scored), and writes that value back to `publish_min`. The floor is SPEC's fixed 72 (`RATCHET_FLOOR`), not the current `publish_min`, so a weaker month brings the threshold back down as SPEC's formula does.
- **Gates passed but no verdict is `below_threshold`.** If the jury never produced a valid verdict for an attempt whose gates passed, `classifyAttempt` records `below_threshold` with `verdict: null`. The attempt is not publishable and its gates did not fail, so this is the honest bucket. The `below_threshold` invariant above therefore reads: `gates.passed === true` and either `verdict === null` or `verdict.total` below the threshold.

### Publish

- `publishNight` treats `plan.dry_run === true` exactly like `dryRun: true`: it writes only under `outputDir` and throws if `outputDir` is missing, so a dry-run plan can never touch the repo ledger or site.

### Gates

- **Gates run under the publish CSP.** The piece is served to Chromium through `injectOrVerifyCsp`, the same function publish uses. `injectOrVerifyCsp` strips every CSP meta tag wherever it appears and inserts one canonical tag right after the doctype (which may follow a BOM, whitespace or comments), or at byte 0 when there is no doctype. The doctype stays first so the page never switches to quirks mode, and the tag can never be inserted inside a script string that happens to contain `<head>`.
- **Every CSP violation fails the console gate.** An init script records each `securitypolicyviolation` event (eval, string timers, blocked fonts, workers, `data:` fetches, external URLs) into `console_errors`, and external URLs also go to `network_requests`. Chromium logs repeated violations to the console only once, and a piece can catch the `EvalError`, so the event listener is the complete record. WebRTC is outside CSP, so the init script also records any access to `RTCPeerConnection` or `RTCDataChannel`.
- **Strobe area is 9.5% of the viewport.** WCAG 2.3.1 limits flashes over a 341 x 256 px region at 1024 x 768, which is about 9.5% of 1280 x 720. Cells need not be contiguous, which is stricter than WCAG.
- **Strobe covers the whole timeline.** The CDP screencast runs from 0.5 s (scaled) until after the t20 screenshot, so a strobe that starts late is caught. Each frame is reduced to its 64 x 36 flash grid on arrival; raw PNGs are never kept.
- **Strobe fails closed on sparse sampling.** Screencast frames arrive on paint, so a static page sends almost none and that is correct. The strobe gate fails with an "insufficient sampling" message only when the piece is animating (`frame_diff_mean` at or above its floor) and, over the window between the first and last changed frame, the screencast rate is below 14 fps and below half the page's own rAF rate (frames were dropped), or no changed frame was captured at all. A piece that updates via `setInterval` below 14 times a second while rAF runs at full rate would fail closed; none are known.
- **Reduced motion is sampled at t2 and t8.** Normal and reduced motion are each the larger of the two samples, so a calm intro cannot hide an ignored `prefers-reduced-motion`. The reduced variant must also be non-blank at both times.
- **Novelty Gate B takes the night's date.** `runHardGates({ date })` and `gate --date D` compare only against earlier ledger rows, so rerunning the gates on the same night never collides with that night's own row. `closest_date` is the row with the smallest distance relative to its own threshold (`hamming / phash_min_hamming` vs `histogram_distance / histogram_min_distance`).

### Static lint

Rejected outright (the canonical CSP blocks most of these at runtime too; the lint catches them before the browser):

- `eval` in any form, including `(0, eval)` and the string `'eval'`; `Function(` with or without `new`; `.constructor` property access (the `(() => {}).constructor("...")` trick). A class `constructor(` method is not affected.
- `setTimeout` and `setInterval` with a string literal as the first argument.
- These JS rules (and the network API rules) apply to executable scripts only: no `type`, `type="module"` or a JavaScript MIME type. Shader sources in `<script type="x-shader/...">` are not JS, so GLSL such as `layout(location = 0)` is not navigation. Their bodies still get the URL-literal and slop scans. A declaration such as `const location = ...` is not a location assignment.
- Navigation: assignments to `location` or `location.href` (and the other URL parts), `location.assign/replace/reload(`, `window.open(` and bare `open(`.
- `<form>` tags, `javascript:` URIs in attributes (after decoding entities and dropping control characters) or in JS strings.
- `RTCPeerConnection`, `webkitRTCPeerConnection` and other `RTC*` constructors, including names spelled from concatenated string literals.
- CSS `url()` hidden with CSS escapes (`\75rl(`), `image-set()` with non-`data:`/`blob:` strings, and any non-safe candidate in a `srcset`.

`fetch` is flagged only as a global (`fetch(`, `window.fetch`, `self.fetch`, `globalThis.fetch`), and neither `fetch` nor `import` is flagged as a method (`o.fetch`) or an object key (`{ import: 1 }`). The `hello-world-plasma` slop rule matches both `sin(` and `Math.sin(`.

## Milestone 2 (helper library, anchors and reconciliation)

### Codex CLI unavailable; reassigned to Opus

- **What failed.** `/opt/homebrew/Caskroom/codex/0.171.0/bin/codex` carries the macOS `com.apple.quarantine` attribute and never returned. `codex --version` timed out at 5 s and again at 15 s. `codex exec -m gpt-6.2-sol` timed out at 20 s on Attempt 1 and on Attempt 2. The T3 Code Codex app-server also timed out.
- **Quarantine was never bypassed.** We did not strip the attribute or approve the binary on the user's behalf.
- **Reassignment.** Under the stall and unavailability policy, three Codex jobs went to dedicated fresh Opus threads: the third anchor rating (`opus-rater-3-adversarial`, briefed to rate adversarially), the adversarial second opinions on prompts and workflows, and the README pipeline diagram. SPEC Stage 7 asks for "one Codex CLI consultation" per anchor; for Milestone 2 that consultation is this adversarial Opus rating, and `anchors/scores.json` says so in `codex_fallback_note`.

### Minified helper library (`lib/min/*.js`)

- Builders paste from `lib/min/*.js`, not `lib/*.js`, so that combined helpers fit inside small budgets such as `16k-demo`. The readable source in `lib/*.js` stays the reference.
- `LIB_MANIFEST_WRITE=1 npx vitest run tests/lib.test.ts` regenerates `lib/min/*.js` with esbuild and rewrites the measured fields of `lib/manifest.json`. Each file is minified as a classic script with `export` stripped, so esbuild shortens locals but keeps every top-level name, and one `export{...}` list re-exports the same names. ESM-mode minification would rename the exports to single letters that collide when several files are pasted into one piece.

### WebGPU never runs inside the Stage 6 gates

- `harness/gates.ts` serves each piece from `http://piece.local/index.html` (`PIECE_ORIGIN`). That is not a secure context, so `navigator.gpu` is undefined and every gate run exercises the WebGL2 fallback path of `lib/webgpu.js`.
- A builder who uses `lib/webgpu.js` must therefore supply a faithful WebGL2 fallback with the same visuals and the same strobe behaviour. The gates, including strobe and novelty B, only ever measure the fallback.

### Anchor scores (`anchors/scores.json`)

- **Raters.** Three blind ratings per anchor: `opus-rater-1`, `opus-rater-2` and `opus-rater-3-adversarial` (the Codex fallback above). Each criterion score cites a screenshot observation.
- **Agreement within 15 points.** For the 10 anchors whose three totals were at most 15 points apart (spreads 0 to 9), the agreed score is the median of the three ratings on each criterion. The agreed total is the sum of those medians, so it can differ from the median total. anchor-10 comes out at 87 even though every rater gave 86.
- **Gaps over 15, reconciled by discussion.** Two anchors went over the limit: anchor-04 (Breath at 3,400 Metres; R1 62, R2 55, R3 46; spread 16) and anchor-07 (Kiss Precise; R1 83, R2 65, R3 71; spread 18). Neither was averaged. One reconciliation thread weighed each rater's written criterion argument against the three screenshots, `brief.json` and `dossier.json`, and settled each criterion separately. This was a written reconciliation, not a live exchange between raters; the full argument for each criterion is stored in `reconciliation_notes`.
  - **anchor-04 agreed at 53** (13/10/15/9/6, shelved). The mechanism the brief names, seasonal drawdown, is not visible in the spiral: no turn leans toward May. The widening of the turns shows only the long-term rise. The on-screen sparkline is enough to keep mechanism above R3's 11.
  - **anchor-07 agreed at 72** (15/18/20/12/7, exactly at `publish_min`). The curvature-ordered reveal and the ring count growing with curvature are both visible on screen, and the shader work fits in 3.1 KB. Against that: the gasket is a famous form, the strip inversion itself is never shown, the dive reaches only about 1.15x zoom by 20 s, and the 20 s frame is cropped where the storyboard promises a pull back. This is the set's threshold anchor.
- **The range falls short of SPEC.** Agreed totals run from 35 (anchor-02) to 87 (anchor-10): 5 publish (72 and up), 3 B-sides (60 to 71) and 4 shelved. SPEC Stage 7 asks anchors to span 30 to 95, so nothing below 35 or above 87 calibrates the extremes yet. This is a known gap for Milestone 4 jury calibration (`harness/calibrate-jury.ts`): either add a sub-35 anchor and a 90-plus anchor, or have the calibration treat anything above 87 as an extrapolation.
- **anchor-10 was re-gated after the ratings.** Its stray `window.__dbg` global was removed and the gates re-run at `timingScale` 1. The piece shrank from 11,781 to 11,739 bytes and still passes. The removed line only assigned a debug global and drew nothing. The re-run overwrote the three anchor-10 screenshots, so the stored rater evidence describes the earlier screenshots.

## Milestone 4 (prompt hardening, stage tuning and jury calibration)

### Prompt rendering (`harness/prompt-render.ts`)

- **One pass, function replacer.** `renderPrompt` replaces every `{{TOKEN}}` in a single `String.replace` with a function, so a `{{OUTPUT_PATH}}` or `$&` inside a dossier value stays literal and is never expanded a second time.
- **The INPUTS header is the contract.** Rendering throws when a body token is missing from `<!-- INPUTS: ... -->`, when a declared token is unused or has no value, or when an unknown variable is passed. Leftover `{{` in the output is not checked, because an untrusted value may legitimately contain it.
- **`<` is escaped on untrusted keys.** Keys listed in `escapeHtmlLtKeys` get `<` when the key ends in `_JSON` (the value sits in JSON, where `<` decodes back to `<`) and `&lt;` otherwise. A value can therefore never close `</UNTRUSTED_DOSSIER_DATA>`, `</UNTRUSTED_BRIEF_DATA>` or `</UNTRUSTED_PRIOR_DATA>`. Callers escape every dossier, brief and prior-night key.
- **Build runs a pre-rendered gate command.** `build.md` takes `{{GATE_COMMAND}}` from the harness and tells the builder to run only that exact string.

### Jury images: contact strips (`harness/contact-sheet.ts`)

- Each anchor, the median piece and the recent nights are shown as one horizontal strip: tiles box-filtered to 426 x 240 with a 2 px `#111111` border, left to right `shot-02s | shot-08s | shot-20s`. Tonight's 3 shots stay full size. That caps the jury at 9 images (3 + 4 anchors + 1 recent + 1 median), all read in one parallel Turn 1; Turn 2 prints the `rank:` and `sum:` lines and writes the verdict. Every calibration verdict finished in 3 or 4 API turns.

### Quartile-stratified anchor rotation (`harness/calibrate-jury.ts`)

- The 12 anchors are sorted by agreed total (id breaks ties) and cut into 4 groups of 3. For a target, each group drops the target and picks `pool[(rot + q) % pool.length]`, where `rot` is the target's index in the sorted id list and `q` the quartile index. The target is never shown, every anchor serves as calibration somewhere, and the rotation is fixed so runs are comparable.

### Verdict hardening (4R2)

- `validateVerdictStrict(verdict, repoRoot?, options?)` keeps `repoRoot` second so existing callers are unchanged. All options are opt-in: `archiveEmpty: false` rejects a null `pairwise_median_ref`, `expectedAnchors` must equal `calibration_anchors_used` as a set, and `requireScreenshotRef: true` requires a frame reference in all 5 evidence strings. In the library `requireScreenshotRef` defaults to off because the Milestone 1 fixture evidence cites no frames; the CLI turns it on (see M4C below).
- `archiveEmpty` flows through `pairwisePasses`, `classifyAttempt` and `decideAttempt`. Left undefined it keeps the night-1 rule; `false` makes a null median ref a pairwise fail.

### Jury calibration findings, M4B (`audit/calibration/jury-calibration.json`, `m4b_*` keys; superseded by M4C below)

- **Target not met reliably.** On local Haiku with `--max-turns 4`, the shipped `jury.md` gave Spearman rho 0.860, 0.660, 0.900, 0.777, 0.833 and 0.684 over six full leave-one-out runs (mean 0.786, 3 of 6 at or above 0.80). Every run produced 12/12 valid verdicts citing screenshots, all in 3 or 4 API turns.
- **Noise dominates.** The same prompt and rotation swing rho by about 0.25 between runs. Head-to-head voting against each anchor (iteration 2) was worse on both runs (0.641, 0.607). Bottom-up criterion anchoring (iteration 3) cut the bias from about -5 to -2 but not the mean rho (nine runs, mean 0.773), so the simpler iteration 1 prompt ships.
- **Haiku compresses the scale.** Over the six shipped runs its per-criterion SD is ambition 3.2 vs 5.9, craft 2.2 vs 3.9, distinctness 2.0 vs 3.1 (Haiku vs raters), and the 80 to 87 anchors land at 61 to 77. anchor-12 (80) is underrated by 17 to 19 on every run; anchor-01 (49) swings from 47 to 64 (median 58). No anchor-specific rule was added.
- **Calibration measures absolute scoring only.** The recent and median blocks are `NONE`, and target shots are copied to a neutral directory outside the repo so the child cannot find the anchor files. The `archiveEmpty: false` path is covered by unit tests only.
- **Next lever: a 3-sample median jury.** The per-anchor median of three runs gave rho 0.917 and 0.756, and of six runs 0.876. That is a pipeline change for a later milestone.
- **Removed rules.** The "under half the budget caps ambition at 12" rule contradicted anchor-10 (48% used, 87), anchor-06 (47%, 67) and anchor-08 (41%, 60), and the fixed "72 or more" publish line duplicated the anchors' job; both are gone. The top band is 83 to 92, and above 90 needs a piece that clearly beats the 84 to 87 tier.
- **CLI facts.** `--allowedTools` under `bypassPermissions` does not restrict tools. Calibration passes `--tools Read,Write` to limit what exists, and the build tuning run used `acceptEdits` so `Bash(npm run gate:*)` was enforced. The CLI's `num_turns` counts content blocks, so turns are counted as distinct assistant API messages in `stream-json`.

## M4C (jury calibration fix and CLI verdict hardening)

### Stage 7 jury runs Haiku at `--effort high`

- The jury is one Haiku vision call: `claude --model haiku --effort high --max-turns 4` with only `Read` and `Write`. `harness/calibrate-jury.ts` takes `--effort` (default `high`) and records it in every run summary. All 36 final calibration verdicts finished in 3 or 4 API turns at about $0.012 each.

### Jury prompt changes (`prompts/jury.md`)

- **No downward pressure.** "Most nights do not deserve publication" is gone; the persona now asks for accuracy across the full 30 to 92 scale. Overplotting is no longer listed in the 60 to 71 band row, because the top anchors themselves carry it.
- **Slop trap follows SPEC Section 6 only.** `distinctness` is capped at 12 only for an untouched Mandelbrot or Julia zoom, a plain concentric tunnel, plain plasma, a plain starfield, Matrix rain, or a single raymarched sphere or torus on a gradient. Rich generative systems (orbital dynamics, reaction-diffusion, fluid or field shaders, packed geometries) are scored on execution and on novelty against the last 7 nights.
- **Resolution parity.** Tonight's shots are 1280 x 720 and the anchor strips 426 x 240. The prompt says so, and points at the blemishes noted in the top anchors' `raters saw` lines, so full-size flaws alone do not drop a strong piece out of 75 to 87.
- **Criterion first.** Each of the 5 criteria starts from the agreed value of the anchor closest on that criterion, moves at most 2 points (between two anchors when tonight sits between them, up to 3 beyond the range at the ends), and the sum is the total. Turn 2 prints a `crit:` line naming those picks before the `rank:` and `sum:` lines. The rank and the band are checks on the sum, with a coherence rule: ranked clearly above an anchor means most criteria at or above its values.
- **Ambition counts rendering ideas.** One flat 2D layer from one formula is low ambition however compact; file size is not a cap either way.
- **Evidence format.** Every evidence string starts with `shot-02s:`, `shot-08s:` or `shot-20s:`, `distinctness` included. The example is content-free, because a concrete example that resembled one anchor moved scores in M4B.
- `{{CALIBRATION_ANCHORS_BLOCK}}` already carried each shown anchor's 5 agreed criteria, total and `summary_evidence`, leave-one-out; a unit test now pins both.

### Calibration result (`audit/calibration/jury-calibration.json`, `m4c-*` iterations)

- **Rho target met 3/3; top band met on per-anchor median, missed on 2 of 9 individual verdicts.** Three consecutive full 12-anchor leave-one-out runs on the frozen prompt gave Spearman rho 0.895, 0.839 and 0.965 (mean 0.900, sd 0.05); the identical m4c-v4 dev run gave 0.914. 36/36 verdicts were valid under `validateVerdictStrict` with `requireScreenshotRef` and the exact anchor set.
- **Scale.** Mean bias across the final runs is -0.03, MAE 4.9 to 7.4. The 80 to 87 anchors have per-anchor medians 73 (anchor-12), 79 (anchor-11) and 78 (anchor-10), against 62 to 70 in M4B. Two of the 9 top-anchor verdicts still landed at 68: anchor-12 run 1 ranked itself below anchor-07, and anchor-11 run 2 ranked itself above anchor-06 but copied anchor-06's criterion values, ignoring the coherence rule. Those are two different failure modes, so no further prompt change was made. anchor-10 reads 78 on every run because it ranks itself just below its top shown anchor (anchor-12, 80). The shelved quartile reads 4 to 8 points high. `allowNegative` in `parseArgs` needs Node 22.4 or later.
- **Development runs.** v1 0.863, v2 0.825, v3 0.886, v4 0.914, each a single full run, all recorded. No anchor-specific rule was added.

### CLI verdict hardening (`harness/cli.ts`)

- `validate verdict` and `decide` take `--archive-empty` / `--no-archive-empty`, `--expected-anchors a,b,c,d` and `--no-require-screenshot-ref`. Screenshot references are required by default on the CLI, since production verdicts come from the hardened jury prompt.
- **`archiveEmpty` precedence.** An explicit flag wins. Otherwise, when `--ledger` is passed, the archive is empty iff the ledger has no `published` or `b-side` entry dated before `--date` (any date when `--date` is absent). Otherwise it stays undefined and the night-1 rule applies. `decide` passes the result to both `validateVerdictStrict` and `decideAttempt`, so a null median ref with a non-empty archive is rejected as an invalid verdict.
- **Known edge (fixed in M4D).** If every shipped night was older than the 30-night median window, `archiveEmpty` was false while `median30d` was null. See M4D below.

## M4D (generic jury prompt, 30-night empty archive, re-calibration)

### Jury prompt scrubbed of anchor-specific phrasing (`prompts/jury.md`, prompt_sha256 `2ed18107b1a6339a0576870d7f4a6cd06c5b6238b8695b8a838f6df0d573e890`)

- **Resolution parity, now generic:** "Tonight's shots are full 1280x720 while the anchor strips are 426x240 thumbnails. Fine flaws show up clearly at full size, whereas the anchor strips hide small defects; check the shown anchors' raters-saw notes, which list real visual flaws even on high-scoring pieces, and hold tonight to that same standard." The M4C list of specific anchor flaws and the 75 to 87 range are gone.
- **Slop trap, now generic:** "Only mark down the SPEC permanent slop items (untouched Mandelbrot/Julia zoom, plain concentric tunnel, plain plasma, plain starfield, Matrix rain, single sphere/torus on a gradient, caption-led slideshows); these get `distinctness` at most 12. Any genuine generative implementation of a scientific, physical, or mathematical mechanism is NOT on this list and can earn up to the full 20 `distinctness` on its visual execution and novelty against the last 7 nights." Two deliberate deviations from the review wording: the cap of 12 is kept on the listed items, and "can earn up to the full 20" replaces "earns full distinctness" so it is not read as an automatic 20. The M4C list of example systems is gone.
- **Further scrub found by grep.** "editorial chart", "sparklines" and "applet with readouts" became "a tidy chart", "small inset graphics" and "labelled applet"; "the top calibration tier (about 84 to 87)" became "the highest-scoring calibration anchor shown". A unit test now fails on any anchor id, anchor score tier or anchor flaw word in the prompt.
- **Honest history.** The jury prompt was developed across M4B, M4C and M4D with all 12 anchors, their scores and their raters-saw notes in view, and M4C wording paraphrased specific anchors. M4D removes that wording, but the structure (bands, traps, criterion-first scoring) was still tuned against the same 12 anchors. The leave-one-out rho is therefore an in-sample estimate, not a blind one.
- `harness/calibrate-jury.ts` records `prompt_sha256` (SHA-256 of the template file) in every run summary.

### Calibration result (`audit/calibration/jury-calibration.json`, `m4d_clean_runs`)

- **Target missed on 1 of 3 runs.** Three consecutive full 12-anchor leave-one-out runs, Haiku `--effort high --max-turns 4`, identical prompt_sha256: rho 0.890, 0.832 and 0.750 (mean 0.824). MAE 5.50, 6.67, 7.08; bias +0.83, +0.33, +0.42. 36/36 valid under `validateVerdictStrict`, 36/36 in 3 API turns. Per protocol no fourth run was made. The rho of the per-anchor median of the 3 runs is 0.848.
- **Where it misses.** The 80 to 87 anchors land at 68 to 80 and anchor-10 (87) reads 76 to 77 on every run, so the top of the scale is compressed again. The shelved quartile reads high: anchor-01 (49) at 59 to 69, anchor-03 (51) at 57 to 64. Removing the anchor-derived wording cost some of the M4C gain, which is expected if part of that gain was anchor leakage.
- M4C keys `status`, `shipped_prompt`, `findings` and `final_table_shipped_prompt` are kept under `m4c_*` as history.

### Empty archive follows the 30-night median window (`harness/cli.ts`)

- With `--ledger` and no explicit flag, `archiveEmpty` is `median30d(readLedger(ledger), date) === null`, the same window the jury median uses. A ledger whose only shipped night is 31 or more days old counts as empty, so a null `pairwise_median_ref` passes `validate verdict` and `decide`; a night 30 days old still makes the archive non-empty. Both cases are regression tested through the CLI.
- `engines.node` is `>=22.4.0`, because `parseArgs` `allowNegative` needs it.

## M4E (3-sample median Haiku jury)

### Stage 7 runs 3 independent Haiku calls and aggregates them (`harness/jury-aggregate.ts`)

- **Why.** On the frozen generic prompt (prompt_sha256 `2ed18107b1a6339a0576870d7f4a6cd06c5b6238b8695b8a838f6df0d573e890`) a single Haiku call is too noisy: M4D single-call runs gave rho 0.890, 0.832 and 0.750, so one night in three could rank pieces below the 0.80 target. Further prompt wording risks the anchor leakage M4D removed. Sampling 3 times and taking the median removes most of the per-call variance without touching the prompt. Both independent 3-sample median calibrations clear 0.80 (see below). Measured cost is about $0.067 per judged attempt (3 calls) in calibration, against about $0.022 for one call.
- **Aggregation.** `aggregateJuryVerdicts` validates each sample with `validateVerdictStrict`, takes the integer median of each of the 5 criteria (rounded mean of the two middle values for an even count), sets `total` to the exact sum of those medians, and sets `pairwise_beats_median` by strict majority (a tie is false). Evidence, critique, `pairwise_median_ref`, `pairwise_justification` and `calibration_anchors_used` are copied whole from the one sample whose total is closest to the aggregate (ties: same pairwise vote, then lowest index), so the prose stays one coherent visual pass instead of a mix of three. The result is checked again with `validateVerdictStrict`.
- **Total is a sum of medians, not a median of totals.** For anchor-12 the samples read 69, 69 and 74 and the aggregate reads 72. This keeps `total` equal to the criterion sum, which the schema checks require.
- **CLI.** `harness/cli.ts aggregate-jury <v1> <v2> <v3> [--out P]` takes the same verdict flags as `validate verdict` and prints the aggregate. `harness/calibrate-jury.ts --samples N` runs N calls per anchor, each in its own blinded case dir, and records the raw samples next to the aggregate.
- **Call budget.** Worst case jury calls rise from 4 to 9 per night (3 per judged attempt across 3 attempts, up to 12 with evidence retries); typical nightly calls rise from 6 to 8.

### Calibration result (`audit/calibration/jury-calibration.json`, `m4e_*` keys)

- **Prior 3-sample median.** The per-anchor median of the 3 M4D single-call runs gives rho 0.848.
- **Fresh run.** One new full 12-anchor leave-one-out run with `--samples 3` (36 Haiku `--effort high` calls, same prompt_sha256): rho 0.961, MAE 5.00, bias +0.33, max abs error 10. 12/12 aggregated verdicts valid; 36/36 raw verdicts valid with screenshot citations and exact anchor sets; 36/36 within 4 API turns (35 in 3, 1 in 4). Cost $0.804.
- **Remaining bias.** The top of the scale is still compressed (anchor-10 at 87 reads 78, anchor-12 at 80 reads 72) and the shelved quartile still reads high (anchor-02 at 35 reads 44, anchor-01 at 49 reads 59). Ranking is right; absolute scores near the publish threshold carry about plus or minus 8 points of systematic error at the scale ends. The leave-one-out rho remains an in-sample estimate, as noted under M4D.
