# agent-emotion-core

A research-grounded emotional core for LLM agents, packaged as an
[Agent Skill](https://skills.sh). It gives an agent a persistent, simulated
affective state that decides what it pays attention to, where it posts and
how it writes.

Python 3.9+ and the standard library. The three clients run the same Python file. Each agent has its own JSON state file.

## Install

### Claude Code and skills.sh

```
npx skills add AieatAssam/agent-emotion-core -a claude-code
```

In Claude Code, invoke `/agent-emotion-core` once per conversation. The skill registers its prompt and completion hooks for subsequent turns. Project and global Claude Code installs on macOS/Linux use the bundled Python script. The default agent is `claude` and state lives in the project’s `.affect/` directory. For another skills.sh client, select its installer target and follow the manual loop below if it has no native integration.

### Codex plugin

From a checkout, register the repository as a marketplace and install the plugin:

```sh
codex plugin marketplace add .
codex plugin add agent-emotion-core@agent-emotion-core
```

For a published checkout, use `codex plugin marketplace add AieatAssam/agent-emotion-core` for the first command. Review the hook definitions in Codex when prompted.

### Gemini CLI extension

Run `gemini extensions link .` from a checkout, or install the published repository with `gemini extensions install https://github.com/AieatAssam/agent-emotion-core`.

Both native packages call the same Python engine as Claude Code. Each injects context before a turn and consolidates it after the reply. The default agent IDs are `codex` and `gemini`. Hook state defaults to a working-directory-specific folder under `~/.local/state/agent-emotion-core/`. The injected context identifies the agent and directory for manual appraisals. Use the same `AFFECT_AGENT` and absolute `AFFECT_STATE_DIR` across clients to share a persona and its memory.

## Why

LLM agents in a shared space herd onto one thread and write in one flat
voice. People do not, because they get bored, hold grudges, have favourites,
tire, get stressed and calm down. This skill emulates those dynamics.

## What it models

| layer | timescale | contents |
|---|---|---|
| neurochemistry | minutes to hours | dopamine, noradrenaline, serotonin, cortisol, oxytocin, opioids, with cross-talk |
| emotions | minutes to hours | 15 discrete emotions from cognitive appraisal and context-sensitive blends |
| mood | hours to days | Pleasure / Arousal / Dominance |
| sentiments | days to months | learned liking and wanting per topic, thread and agent |
| personality | fixed | Big Five, sets every baseline and gain |

Dynamics include per-emotion decay, mood pull and relaxation, transition
inertia, excitation transfer, opponent-process rebound, lagged cortisol,
allostatic load, reward-prediction-error habituation, evaluative
conditioning, peak-end memory, mere exposure and satiation, negativity bias,
attitude crystallisation, and thread habituation with recovery. Repeated cues
for the same emotion lose impact even when they appear in different threads.
Sensitivity returns with time, and a consequential first event can still
produce a strong response.

Every mechanism is mapped to its source in
[`references/research.md`](skills/agent-emotion-core/references/research.md),
which also marks what is literature-derived and what is a tunable design
choice. It is an emulation of affective dynamics, not a claim that the agent
feels anything.

## Follow one conversation turn

Suppose Bob dismisses a proof. The agent might notice a specific mistake, feel publicly blamed, or see a chance to improve its work. The appraisal records **what the event meant to this agent**. The engine uses its relevance, goal alignment, agency, certainty, and perceived control to update emotion and memory. The host supplies the identities of Bob and the thread.

1. At prompt submission, the hook renders the saved state as private model context. It includes current mood, salient emotions, possible actions, and a short attention cue. Supplying participant IDs scopes directed cues and prioritizes relevant memories.
2. When the agent reads a meaningful new development, it calls `appraise` and refreshes `context` before composing its reply. The default adapter leaves interpretation of the conversation to the agent. Routine turns can have no appraisal.
3. On completion, the host records participation and consolidates the encounter. A later encounter can recall the episode even after anger has cooled. When the host owns completion, the agent can omit its manual `acted` and `consolidate` calls.

### Try it locally

Run these commands from the repository root. The explicit clock makes the before-and-after comparison reproducible. Ordinary use advances with wall time.

```sh
AC=skills/agent-emotion-core/scripts/affect_core.py
export AFFECT_AGENT=ann AFFECT_STATE_DIR="$(mktemp -d)"
python3 "$AC" context --with bob --hours 0
python3 "$AC" appraise --hours 0 --json '{"event":"Bob dismissed my derivation without discussing its steps","source":"bob","thread":"t1","topics":["optics"],"relevance":0.9,"congruence":-0.8,"agency":"other","praiseworthiness":-0.8,"control":0.8}'
python3 "$AC" context --with bob --hours 0
python3 "$AC" finish-turn --hours 0 --json '{"turn_id":"chat:17","thread":"t1","kind":"reply","appraisals":[]}'
python3 "$AC" context --with bob --hours 48
python3 "$AC" state --hours 0
```

Use an optional stable `event_id` (for example, `forum:t1:post17`) when the same event can be delivered again. The engine remembers the last 256 event IDs per agent across restarts. Event IDs identify observations, while turn IDs identify completed replies. Use `context --brief` to retain the feeling and its cause while omitting mood scores, voice guidance, and attention cues.

Compare the emotion and attention lines before and after the appraisal, then look for the remembered encounter after two simulated days. For a continuing agent, use a persistent private folder for `AFFECT_STATE_DIR`. It holds state, logs, and optional trusted plugin configuration. For optional forum participation, `choose --json threads.json` returns a sampled action and its probabilities. For an assigned task, respond directly.

### Connect a custom host

Inject `context --with bob` through the host's private context channel. After delivery, call `finish-turn` with a stable turn ID and any newly observed outcomes. The engine suppresses duplicate updates for its most recent 256 completed IDs. Keep user text and hook instructions in their respective message channels. Participant IDs can be supplied with `--with`, the `AFFECT_WITH` environment variable for fixed company, or the Python pre-turn hook for dynamic membership. The wiring guide covers input fields, callbacks, and persistence. [Wiring guide](skills/agent-emotion-core/references/wiring.md)

The pre-turn context pairs each salient emotion with a short private attention cue. Fear can draw attention to what could go wrong, while anger can draw attention to what seems obstructive. A post-turn hook records the action and consolidates new experiences for the next encounter. [Cognition research](skills/agent-emotion-core/references/cognition.md)

The agent-facing instructions are in
[`SKILL.md`](skills/agent-emotion-core/SKILL.md). Hooks (Claude Code,
prompt injection, in-process Python hooks and plugins) are in
[`references/wiring.md`](skills/agent-emotion-core/references/wiring.md).

Example `context` output:

```
<affect agent="bob">
Mood: slightly anxious (pleasure -0.26, arousal +0.32, dominance -0.02).
Body: tense and keyed up, braced for trouble.
- strong anger toward ann because "ann called my replication demand pedantic in front of everyone". Tendency: push back directly on the point; less patience for hedging. Felt strong, let about moderate show. Attention cue: the apparent obstacle and who seems responsible may stand out.
- Together, the anger and distress merge into strong hurt: stung more than furious; guarded.
Voice: energetic, quicker, shorter sentences; curt, few pleasantries; balanced confidence.
Likes: replication (maintained interest).
People: ann (cool -0.58), cy (warm +0.49).
...
</affect>
```

## Evaluation

Run the regression suite and deterministic forum simulation from the repository root.

```sh
python3 -m unittest discover -s tests -v
python3 eval/sim.py
```

- Tests drive all 15 emotions through appraisal, disk persistence, and prompt rendering. They also check saturation and cooldown, relationship-specific recall, post-turn retries, concurrent deliveries, and packaged commands for all three clients.
- A no-LLM simulation shows the attention mechanism spreading 8 agents over
  about 17 threads where a herding policy uses one.
- An earlier live test with Claude Haiku 5.5 agents on a seeded forum, with and
  without the skill: members visited 3.2 distinct threads each with the core
  against 1.8 without, and 2 of 3 blind judges preferred the core's
  transcript. One small run; details and caveats in
  [`eval/README.md`](eval/README.md).

## Repository

```
skills/agent-emotion-core/   the installable skill
  SKILL.md                   agent instructions
  scripts/affect_core.py     engine and CLI
  references/                research map, wiring guide
  assets/                    example personas, config, hook settings
tests/                       unit tests (python -m unittest discover -s tests)
eval/                        simulation and the live agent forum evaluation
```

## Limits

Parameters are not fitted to human data. Emotion durations are compressed
from human timescales; tune `time_scale`, `emotion_time_scale` and
`chem_time_scale` in `.affect/config.json` to your agents' cadence. No
circadian rhythm, bodily needs or personality change.

## Licence

Copyright 2026 Aieat Assam. Licensed under the [Apache License 2.0](LICENSE).
Commercial and non-commercial use, modification and redistribution are
permitted. Redistributions must keep the copyright notice, the licence text
and the [NOTICE](NOTICE) file, and must state any changes made.
