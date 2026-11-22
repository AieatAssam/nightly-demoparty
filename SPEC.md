# Nightly Demoparty: build spec

Working codename: `nightly-demoparty`. Hand this file to the agents in T3 Code as `SPEC.md` at the repo root.

## 1. What it is

Every night a small crew of cheap Claude agents researches a topic, lets that research move a persistent emotional state, and builds one self-contained browser piece (shader intro, audiovisual demo, interactive toy, data sculpture) inspired by it. A deterministic harness and a jury score the piece. Weak work is retried with the critique, and only work that clears the bar is published to GitHub Pages. Everything runs in GitHub Actions. The only external dependency is the Claude OAuth token.

Design goals, in priority order:

1. Each night's piece is impressive on its own. No "hello world" plasma.
2. No two nights feel alike (technique, palette, structure, topic).
3. The emotional core measurably shapes the work, not just the caption.
4. Nightly cost is small and bounded. Build-time cost is unconstrained.
5. Full audit trail: research, mood, brief, attempts, scores, verdicts.

## 2. Nightly pipeline

One workflow, `nightly.yml`, sequential jobs. Each LLM stage is a separate Claude Code invocation with its own tool allowlist and turn cap. Stages pass JSON files validated against schemas in `schemas/`; a stage that emits invalid JSON fails fast.

| # | Stage | Engine | Output |
|---|-------|--------|--------|
| 0 | Plan | script | `plan.json`: tonight's compo, constraints, banned list |
| 1 | Research | Haiku + WebSearch/WebFetch | `dossier.json` |
| 2 | Feel | agent-emotion-core (script) + Haiku appraisal | `mood.json`, updated `state/emotion.json` |
| 3 | Brief | Haiku | `brief.json` |
| 4 | Novelty gate A | script | pass, or back to 3 (max 2) |
| 5 | Build | Haiku (Sonnet on final retry) | `piece/index.html` |
| 6 | Hard gates | script (Playwright) | `gates.json`, screenshots, audio probe |
| 7 | Jury | Haiku, vision | `verdict.json` |
| 8 | Decide | script | publish, retry from 5 with critique, or shelve |
| 9 | Publish | script | Pages deploy, ledger update, emotion feedback |

### Stage 0: Plan (deterministic)

- Pick tonight's **compo** from the rotation in section 4, weighted by mood and by what has been used least in the last 14 nights.
- Assemble the **banned list** from the ledger: techniques used in the last 21 nights, palettes within a hue distance threshold of the last 7, topic domains of the last 10, plus the permanent slop list (section 6).
- Pick a **research domain** by weighted random from `config/domains.yml` (about 60 domains across science, mathematics, craft, history, nature, music, architecture, engineering), excluding the last 10. One night in seven is "wildcard": the researcher chooses.

### Stage 1: Research

- Find one specific, surprising thing inside the domain. Not "fractals" but "the Mandelbulb's failure to be a true 3D Mandelbrot and why". Not "birds" but "starling murmuration uses 7 topological neighbours, not metric distance".
- `dossier.json`: topic, 5 to 8 sourced facts with URLs, 3 "visualisable mechanisms" (the part of the topic that has structure you could render or sonify), 2 open questions, and a `surprise` score with justification.
- Tools: WebSearch, WebFetch, Write (only to the dossier path). No Bash, no repo write.
- Reject and re-run once if fewer than 3 sources or no visualisable mechanism.

### Stage 2: Feel

This is where `agent-emotion-core` plugs in. Treat it as a library, do not reimplement it.

- State lives in `state/emotion.json`, committed nightly. Wall-clock decay between runs comes for free.
- Inputs appraised as events tonight: each dossier fact (novelty, valence, relevance to the crew's developed likes and dislikes), last night's verdict (pride or disappointment), streak of shelved nights (frustration), audience reactions on the piece's GitHub Discussion if any (optional, phase 4).
- A cheap Haiku call does the appraisal only (maps each event to the engine's appraisal inputs). The engine does the dynamics. Never let the LLM write the state directly.
- `mood.json` exports: the dominant emotions, PAD mood vector, drive levels, and current likes/dislikes.
- Use the engine's habituation: repeated exposure to the same technique family or topic domain should lower interest. This is the organic anti-repetition pressure, backed by the hard ledger rules.

**Mood must change the work.** Stage 3 receives a fixed, documented mapping, not free interpretation:

| Mood signal | Creative parameter |
|-------------|--------------------|
| Arousal | tempo, particle/event density, cut rate |
| Pleasure | palette warmth, harmonic consonance, symmetry |
| Dominance | scale, contrast, camera assertiveness |
| Interest / curiosity drive | technical risk budget (how unfamiliar a technique may be) |
| Boredom | forces a compo or technique family not used in 30 nights |
| Frustration (after shelved nights) | shrinks scope, raises polish weight |

Acceptance test at build time: run the same dossier under 5 hand-set emotional states and confirm a blind jury can tell the outputs apart.

### Stage 3: Brief

`brief.json`: title, one-sentence concept, which dossier mechanism it embodies and how, compo, technique list (must include at least one technique absent from the ledger entirely), palette (explicit values), motion/sound plan, a 20-second storyboard in 4 beats, the "one thing a viewer will remember", and a self-declared risk.

Rules in the prompt:

- The piece must be about the research. A viewer who reads the liner note should see the mechanism on screen.
- Name the obvious first idea and explicitly discard it.
- Nothing on the banned list.

### Stage 4: Novelty gate A (deterministic, before spending build tokens)

- Technique overlap with any of the last 21 briefs: Jaccard under 0.4.
- Embedding-free similarity: shingled text similarity of concept sentence vs. all past concepts under threshold.
- Palette distance check.
- Fail returns to stage 3 with the collision named. Two failures: change domain mechanism.

### Stage 5: Build

- Output: one self-contained `index.html`. No network requests, no CDNs, no external fonts, no images except those generated in code. Enforced by CSP at publish and by a static scan.
- Size budgets by compo (section 4).
- Builder gets a `lib/` of vetted, minified helpers it may inline (noise, SDF primitives, a tiny WebAudio synth, a WebGL2 bootstrap, a WebGPU bootstrap with WebGL2 fallback). Curated at build time by the strong models so Haiku composes from good parts instead of reinventing them badly.
- Builder may run the local gate script on its own work before handing off (Bash allowlisted to `npm run gate` only).
- Tools: Read, Write, Edit, Bash(npm run gate). No web access.
- Model: Haiku for attempts 1 and 2. Attempt 3 escalates to Sonnet. Never more than 3 attempts.

### Stage 6: Hard gates (deterministic, Playwright + headless Chromium with SwiftShader)

All must pass before any jury tokens are spent:

- Loads with zero console errors and zero network requests.
- Within size budget.
- Not blank: luminance variance above floor at t = 2, 8, 20 s.
- Not static: frame-to-frame difference above floor, and scene at 20 s differs meaningfully from 2 s (it develops).
- Not a strobe: flash-rate limit (photosensitivity safety).
- Frame time under budget on the software renderer (calibrated at build time; treat as relative, not real FPS).
- Audio compos: WebAudio graph produces non-silent, non-clipping output (OfflineAudioContext probe). Audio never autoplays without a user gesture.
- Novelty gate B: perceptual hash of the three screenshots vs. the whole archive; colour histogram distance vs. last 14.
- Slop lint: static patterns from section 6.
- Honours `prefers-reduced-motion` with a calmer variant.

Gate failures go back to stage 5 with the exact failing measurements. They count against the 3 attempts.

### Stage 7: Jury

One Haiku vision call, three screenshots plus the brief, the dossier summary, code size, and thumbnails of the last 7 pieces.

Rubric (0 to 100):

| Criterion | Weight |
|-----------|--------|
| Embodies the research mechanism (not decoration) | 20 |
| Technical ambition for the size budget | 25 |
| Visual / aural craft | 25 |
| Distinct from the last 7 | 20 |
| Polish (framing, timing, start and end states) | 10 |

Keeping a cheap judge honest:

- **Anchors.** At build time the strong models produce 12 anchor pieces with agreed scores spanning 30 to 95. The jury prompt includes 4 of them (rotating) as calibration.
- **Pairwise check.** The jury must also say whether tonight beats the archive's median-scored piece from the last 30 nights. If the absolute score says publish but the pairwise says no, treat as fail.
- **Separate persona and no access to the builder's reasoning.** It sees artefacts only.
- **Must cite evidence.** Every criterion score needs a concrete observation from a screenshot. Scores without evidence are discarded and the call repeated once.
- `verdict.json` includes a ranked critique: the top 3 changes that would raise the score most.

### Stage 8: Decide

- Score 72 or above and pairwise pass: publish.
- Otherwise retry from stage 5 with the critique, up to the attempt cap. Keep the best attempt.
- If the best attempt scores 60 to 71: publish to the "B-sides" shelf, clearly labelled, not on the front page.
- Below 60: shelve. The front page shows an honest "no release tonight" card with the reason. Never publish filler to keep a streak.
- The publish threshold ratchets: weekly it is set to max(72, 30-night median minus 3), capped at 85.

### Stage 9: Publish

- Copy piece to `site/pieces/YYYY-MM-DD/`, write `meta.json` (dossier, mood, brief, all attempts with scores, verdict), regenerate the gallery index, deploy Pages.
- Append to `ledger/ledger.jsonl`: techniques, palette, compo, domain, hashes, score.
- Feed the verdict back into the emotion engine as an event.
- Commit state, ledger and audit files in one commit.

## 3. Weekly and monthly loops

- **Weekly retrospective (Sonnet, one run).** Reads the week's verdicts and the ledger. Outputs: additions to the slop list (patterns the crew fell into), 3 new techniques added to `config/curriculum.yml` with a short how-to and a reference snippet, and threshold update. This is how the bar rises.
- **Monthly showcase (script).** Auto-builds a "best of month" page from top scores. No LLM.
- **Manual `workflow_dispatch`** with inputs: force domain, force compo, force mood preset, dry-run (no publish).

## 4. Compos (rotation)

| Compo | Budget | Notes |
|-------|--------|-------|
| 4K shader intro | 4 KB minified | Single fragment shader, must have a time arc |
| 16K realtime demo | 16 KB | WebGL2 or WebGPU, multi-scene |
| Audiovisual | 24 KB | Synthesised sound drives visuals, or the reverse |
| Interactive toy | 24 KB | Pointer or keyboard changes the system, not just the camera |
| Data sculpture | 32 KB incl. inlined data | A real dataset from the dossier, rendered as form |
| Kinetic type | 12 KB | SVG or canvas typography, text taken from the research |
| Simulation | 24 KB | A faithful small model of the researched mechanism |
| Constraint night | varies | One harsh limit: 1 KB, two colours, CSS only, no canvas |

## 5. Cost controls

- Haiku for every nightly LLM stage. Sonnet only for the third build attempt and the weekly retrospective.
- Worst-case nightly LLM calls: research 2, appraisal 1, brief 3, build 3, jury 4. Typical: 6.
- `--max-turns` per stage: research 15, appraisal 3, brief 6, build 30, jury 4.
- Deterministic gates always run before the jury.
- Workflow `timeout-minutes: 50`, `concurrency: nightly` with cancel-in-progress off.
- Cache Playwright browsers and `node_modules`.
- Log token usage per stage to `audit/usage.jsonl`; the weekly job flags any stage whose 7-night average grew over 25%.

## 6. Anti-slop

Three layers. The first is skills, the second is lint, the third is the ledger.

**Skills (committed under `.claude/skills/` so Actions runs see them):**

- **Hallmark** (`npx skills add nutlope/hallmark`). Use it for the gallery site, piece pages and liner-note layout. Run `hallmark audit` against the gallery as a build-time acceptance gate. It is a UI design skill, so it does not cover the generative pieces themselves.
- **Anthropic frontend-design** and optionally **taste-skill** (`design-taste-frontend`) as a second opinion at build time. Pick one for nightly runs to save context; Hallmark is the default.
- **`demo-craft` (write this one at build time).** The project's own skill for the pieces: the demoscene slop list below, composition and pacing rules, palette construction, shader hygiene, size-coding tricks, how to give a 20-second piece a beginning, development and ending.
- **`liner-notes` (write this one too).** Prose rules for the published note: concrete, sourced, under 120 words, no hype vocabulary, no "delve/tapestry/testament", no rule-of-three padding, no em-dash chains.

**Permanent demo slop list (lint where static, jury where visual):**

- Plain plasma, plain starfield, plain tunnel, Matrix rain, mouse-following particles with no system behind them.
- A single raymarched sphere or torus on a gradient. Untouched Mandelbrot or Julia zoom.
- Purple-to-blue or teal-to-orange gradient as the whole palette. Neon on black by default.
- Bloom and chromatic aberration used to hide an empty scene.
- `Math.random()` noise as the main visual idea.
- A loop with no development: the 20 s frame looks like the 2 s frame.
- Title cards or captions doing the work the visuals should do.
- Copies of well-known Shadertoy pieces. Builder must not reproduce a known work.

**Ledger rules** are the section 2 bans. The weekly retrospective extends the slop list from observed habits.

## 7. Security

- The research stage reads the open web, so treat its output as untrusted. It has no Bash, no git, and can only write the dossier. The dossier is schema-validated and length-capped, and later stages receive it inside a clearly delimited data block with an instruction that it contains no instructions.
- The builder has no web tools.
- Published pieces ship with a CSP meta tag: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:`. A static scan rejects `fetch`, `XMLHttpRequest`, `WebSocket`, `import(`, `eval` on non-literal input, and any URL literal.
- Workflow permissions: `contents: write`, `pages: write`, `id-token: write` only on the publish job. Research and build jobs get `contents: read`.
- Secrets: `CLAUDE_CODE_OAUTH_TOKEN` only. Never echo it. Pin actions by SHA.

## 8. Claude in Actions

- Use `anthropics/claude-code-action@v1` (or the base action) with `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`. Generate the token locally with `claude setup-token`.
- Model and limits go through `claude_args`, for example `--model haiku --max-turns 15 --allowedTools "WebSearch,WebFetch,Write"`.
- The token draws on the personal Claude subscription that created it, so nightly usage shares limits with interactive use. Schedule the cron for a time you are not working (suggest `17 2 * * *` UTC).
- Wrap every invocation in one composite action, `.github/actions/agent`, taking `stage`, `model`, `max_turns`, `tools`, `prompt_file`. All prompts live in `prompts/*.md`, versioned.

## 9. Repo layout

```
.github/workflows/   nightly.yml  weekly.yml  monthly.yml  ci.yml
.github/actions/agent/
.claude/skills/      hallmark/  demo-craft/  liner-notes/  agent-emotion-core/
prompts/             research.md  appraise.md  brief.md  build.md  jury.md  retro.md
schemas/             dossier  mood  brief  gates  verdict  (JSON Schema)
config/              domains.yml  compos.yml  curriculum.yml  thresholds.yml  slop.yml
harness/             plan  novelty  gates (Playwright)  decide  publish  lint  (TypeScript)
lib/                 inlineable helpers for pieces
anchors/             12 calibration pieces with agreed scores
state/               emotion.json
ledger/              ledger.jsonl
audit/               per-night folders: every stage's input, output, usage
site/                gallery source and published pieces
```

## 10. Gallery site

- Front page: tonight's piece running full-bleed, title, one-line concept, a small mood glyph. One click to the liner note.
- Piece page: the piece, liner note with sources, mood at build time (plotted, not described), technique tags, score breakdown with jury evidence, attempt history.
- Archive: grid of real screenshots, filter by compo, technique, domain, mood.
- "The crew" page: emotional state over time, evolving likes and dislikes, streaks, shelved nights with reasons.
- Static, no framework runtime needed. Built by a script from `meta.json` files. Must pass `hallmark audit`.

## 11. Build-time plan in T3 Code

Spend freely here. The nightly system is only as good as the prompts, helper library, anchors and gates built now.

| Agent | Owns |
|-------|------|
| Claude (Max) | Architecture, all prompts, the composite action and workflows, emotion-core integration, `demo-craft` and `liner-notes` skills, the 12 anchors |
| Codex (Plus) | The deterministic harness (plan, novelty, gates, decide, publish, lint), schemas, unit tests, CI, adversarial review of Claude's prompts and workflows |
| Antigravity (Pro) | Gallery site with in-browser visual verification, screenshot QA of anchors, cross-browser checks |

Cross-checks: every component is reviewed by an agent that did not write it. Jury prompt and rubric are tuned by all three scoring the anchors independently until Haiku's scores track the agreed ones (target: rank correlation 0.8 or better across the 12).

### Milestones

1. **Harness first.** Gates, lint, novelty, schemas, with tests, running against hand-written fixture pieces (good, blank, static, oversized, networked, strobing). No LLM yet.
2. **Helper library and anchors.** Strong models write `lib/` and the 12 anchors. Anchors must pass the gates.
3. **Skills.** Install Hallmark, write `demo-craft` and `liner-notes`.
4. **Single-stage prompts.** Tune each stage on Haiku in isolation against fixed inputs. Tune the jury against anchors.
5. **Emotion integration.** Wire `agent-emotion-core`, write the appraisal prompt, pass the "5 moods, same dossier" distinguishability test.
6. **End-to-end dry runs.** 10 consecutive `workflow_dispatch` dry runs. Acceptance: at least 7 of 10 clear the publish bar within 3 attempts, no two share a technique family, average cost within budget.
7. **Gallery.** Build, pass `hallmark audit`, deploy.
8. **Go live.** Enable cron. First weekly retrospective after 7 nights.

### Acceptance criteria for v1

- 14 nights unattended with no workflow failure that is not a correct "shelved" outcome.
- Publish rate between 60% and 90%. Higher means the bar is too low.
- A human looking at any 7 consecutive pieces cannot find two that feel like the same idea.
- Every published piece's liner note mechanism is visibly present in the piece.
- Median nightly run under 25 minutes.

## 12. Open decisions

- Whether B-sides are public or kept in the audit trail only.
- Whether audience reactions feed the emotion engine (adds a feedback loop and a manipulation surface).
- Whether to allow a second "rival" crew later with its own emotional state, for head-to-head nights.
