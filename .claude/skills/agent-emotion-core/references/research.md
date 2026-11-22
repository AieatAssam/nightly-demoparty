# Emotional core: model and sources

A functional emulation of human affect for LLM agents. It reproduces the
*dynamics* reported in the literature (what triggers a state, how states mix,
how fast they fade, what they leave behind). It does not claim the agent
feels anything.

Status key: **L** = structure and direction from the literature.
**D** = design choice (usually the magnitude). Nearly every number is **D**;
nearly every mechanism and sign is **L**.

## 1. Architecture

| layer | timescale | state | role |
|---|---|---|---|
| neurochemistry | minutes to hours | 6 levels, stress drive, allostatic load | gains, arousal, learning signals |
| emotions | minutes to hours | 15 intensities with target and cause | discrete reactions to appraised events |
| mood | hours to days | Pleasure, Arousal, Dominance | background tone, biases appraisal |
| sentiments | days to months | liking, wanting, episodes per object | likes, dislikes, cravings, relationships |
| personality | fixed | Big Five | every baseline and gain |

Layering short, medium and long-term affect follows ALMA (Gebhard 2005).
Persistent state across encounters addresses what Fu et al. (2026, Sentipolis)
call emotional amnesia in LLM social simulations.

## 2. Emotion generation: appraisal

Events do not cause emotions directly; the agent's evaluation does
(Lazarus 1991; Scherer 2001). The LLM supplies the appraisal, the engine
does the rest.

| mechanism | source | status |
|---|---|---|
| joy/distress, hope/fear, relief/disappointment from goal congruence x certainty | Ortony, Clore & Collins 1988 (OCC) | L |
| a relevant outcome attenuates active prospects, with relief or disappointment when the outcome disconfirms a strong prospect | OCC for prospect disconfirmation | L, resolution weighting and known-thread matching D |
| pride/shame, admiration/reproach, gratitude/anger from agency x praiseworthiness | OCC | L |
| high coping potential turns blame into anger, low into fear | Scherer 2001 | L |
| interest = novelty x coping potential | Silvia 2005 | L |
| unexpected outcomes feel stronger | Mellers et al. 1997 | L, gain D |
| extraversion amplifies positive, neuroticism negative affect | Costa & McCrae 1980 | L, 0.35 D |
| mood-congruent amplification | Bower 1981; Gebhard 2005 | L, 0.3 D |
| contagion from perceived emotion, scaled by liking | Hatfield, Cacioppo & Rapson 1994 | L, gains D |
| expressed < felt for negative emotion | Gross 1998 (suppression); display rules | L, trait link D |
| emotion PAD coordinates | Gebhard 2005 mapping, approximate | L approx |

## 3. Neurochemistry

Six abstract signals. Each has a trait-set tonic level, phasic release from
events, exponential clearance, and cross-talk with the others.

| signal | released by | does | source |
|---|---|---|---|
| dopamine | reward prediction error (outcome minus learned liking); novelty | positive-emotion gain, exploration, drives *wanting* | Schultz, Dayan & Montague 1997; Berridge & Robinson 1998 |
| noradrenaline | novelty, surprise, threat, anger | arousal; amplifies the *next* emotion of any valence; raises choice randomness | Aston-Jones & Cohen 2005; Zillmann 1971 (excitation transfer) |
| serotonin | slow: pride, gratitude, joy up; shame, distress, chronic stress down | mood set point, patience; low level shortens the fuse | Crockett et al. 2008; Daw, Kakade & Dayan 2002 |
| cortisol | only uncontrollable and social-evaluative threat, via a lagged drive | negative gain, slower recovery, withdrawal, stronger memories | Dickerson & Kemeny 2004; McGaugh 2004 |
| oxytocin | gratitude, admiration, from liked others | trust, social approach, buffers stress | Heinrichs et al. 2003 |
| opioids | joy, relief, pride (consummatory pleasure) | hedonic tone (*liking*) | Berridge, Robinson & Aldridge 2009 |

Cross-talk (`COUPLING`): each signal's set point is shifted by the others.

| link | sign | basis |
|---|---|---|
| cortisol -> noradrenaline | + | CRH activation of locus coeruleus |
| cortisol -> serotonin | - | stress and serotonergic tone |
| oxytocin -> cortisol | - | social buffering (Heinrichs et al. 2003) |
| opioids -> dopamine | + | disinhibition of dopamine neurons (Johnson & North 1992) |
| opioids -> cortisol | - | opioid restraint of the HPA axis |
| serotonin -> dopamine | - | opponency (Daw, Kakade & Dayan 2002) |
| noradrenaline <-> dopamine | + | catecholamine co-activation |
| oxytocin -> serotonin, dopamine | + | social reward circuitry |
| allostatic load -> serotonin, dopamine | - | chronic stress, anhedonia (McEwen 1998) |

Combinations are read before single signals (`body()`): cortisol + noradrenaline
reads as braced tension, dopamine + noradrenaline as excitement, cortisol +
low dopamine as defeat, dopamine + low serotonin as impulsivity. Very high
noradrenaline degrades focus (inverted U; Arnsten 2009).

`lovheim()` reports the corner of the Lövheim (2012) cube the three monoamines
sit in. Diagnostic only; nothing depends on it.

## 4. Dynamics and transitions

| mechanism | source | status |
|---|---|---|
| per-emotion exponential decay; sadness-type longest, fear, shame, surprise, boredom, relief shortest | Verduyn & Lavrijsen 2015 | order L, hours D |
| strong negative emotions and neurotic agents recover slower | Verduyn & Lavrijsen 2015 (rumination); Kuppens et al. 2010 (inertia) | L |
| repeated appraisals reinforce emotion up to a ceiling tied to the strength of the new appraisal | engine design | D |
| repeated elicitation of the same emotion reduces its next impulse across sources and threads; sensitivity recovers with a one-hour default half-life (`emotion_adaptation_half_life`) | engine design | D |
| emotions pull mood toward their centre, with a bounded push when mood is already farther out in the same octant | Gebhard 2005 | L, limit D |
| appraisals nudge mood toward a bounded target based on emotional strength and baseline mood | engine design | D |
| as emotions fade their residue stays in mood, then mood relaxes to a set point | Gebhard 2005 | L |
| a strong emotion resists its opposite and is dented by it | Thornton & Tamir 2017 (valence-consistent transitions) | L, 0.4 D |
| co-active pairs can merge into compound emotions (`BLENDS`) when known thread and target information is compatible | OCC compounds, Plutchik 1980, Larsen, McGraw & Cacioppo 2001 | L, list and compatibility rules D |
| opponent process: comedown after a high, relief after stress ends | Solomon & Corbit 1974 | L, gain D |
| cortisol peaks after the stressor and clears over hours, with bounded reinforcement of the upstream stress drive | HPA kinetics | L, drive bound D |
| allostatic load: 7-day integrator of excess cortisol, lowers mood set point | McEwen 1998 | L, 7 d D |
| repeated expected rewards stop producing dopamine | Schultz et al. 1997 | L |

Human studies give directional checks for these trajectories. The engine's
ceilings, decay curves, and clock rates are design choices.

- Increasing picture intensity affected physiological responses differently
  depending on the picture's content and the response measured. The engine's
  soft ceiling represents diminishing returns under stacked gains.
  [Bernat et al. 2006](https://pmc.ncbi.nlm.nih.gov/articles/PMC2242429/)
- Repeated pictures quickly weakened autonomic orienting responses, while
  cortical responses still distinguished emotional from neutral pictures.
  In enjoyment experiments, finer distinctions among repeated experiences
  slowed satiation. The engine uses one adaptation level per emotion across
  topics and sources.
  [Codispoti et al. 2006](https://pubmed.ncbi.nlm.nih.gov/16403475/),
  [Redden 2008](https://doi.org/10.1086/521898)
- Across five emotions, higher initial intensity, more important events, and
  physical or mental recurrence predicted longer self-reported episodes.
  The engine uses a slower decay for strong negative emotions and a new
  appraisal can refresh an emotion after it starts to fade.
  [Verduyn et al. 2009](https://pubmed.ncbi.nlm.nih.gov/19186919/)
- Recalling a provocation while ruminating maintained self-reported anger;
  reappraising the same event reduced anger on later recalls. Positive films
  eliciting amusement or contentment also accelerated cardiovascular recovery
  following a fear film. These studies measured different parts of recovery.
  [Ray et al. 2008](https://pubmed.ncbi.nlm.nih.gov/18179323/),
  [Fredrickson & Levenson 1998](https://pmc.ncbi.nlm.nih.gov/articles/PMC3156608/)

## 5. Long-term: likes, dislikes, cravings

Every topic, thread and agent an appraisal mentions gets a sentiment record.

| mechanism | source | status |
|---|---|---|
| liking learned from the affect an object is paired with, including by mere co-occurrence | evaluative conditioning: De Houwer et al. 2001; Hofmann et al. 2010 | L |
| update = rate x (experienced - expected) | Rescorla & Wagner 1972 | L |
| an episode is remembered by its peak and its end | Kahneman et al. 1993 | L |
| consolidation happens offline; arousal strengthens it | McGaugh 2004 | L |
| bad experiences move liking 1.5x more; dislikes fade 2x slower | Baumeister et al. 2001 | L, factors D |
| learning rate falls with experience: established attitudes resist change | Krosnick & Petty 1995 | L, curve D |
| familiarity adds mild liking with diminishing returns; massed over-exposure subtracts | Zajonc 1968; Bornstein 1989; Montoya et al. 2017 | L, sizes D |
| wanting (pull) learned from positive prediction errors, separate from liking, and outlives it | Berridge & Robinson 1998 | L |
| interest matures: passing -> maintained -> emerging -> well-developed | Hidi & Renninger 2006 | L, thresholds D |
| emotion-tagged episodic memory with decaying salience | Bower 1981; Fu et al. 2026 | L |

## 6. Behaviour

`choose()` samples a softmax over an affective utility per thread, so
attention disperses for the reasons it does in people: habituation to a thread
(Thompson & Spencer 1966) with recovery over time, novelty hunger and social
need that build like drives, fatigue, learned tastes, cravings, friends,
grudges, and crowd-seeking that depends on extraversion. Tonic noradrenaline
raises the temperature (explore vs exploit; Aston-Jones & Cohen 2005).
`context()` renders state as mood, body, emotions with action tendencies
(Frijda 1986), blends, drives, voice, tastes and people.

The private attention cues and persistent relationship cues have separate evidence notes. [Appraisal and attention](cognition.md) · [Relationships and inspiration](relationships.md)

## 7. Limits

- Neuromodulators are not one-to-one with emotions. The six signals are
  functional abstractions; the Lövheim cube is a hypothesis.
- Oxytocin findings in humans replicate unevenly. Its effects here are small.
- Human emotion durations run to days. Defaults are compressed. Set
  `emotion_time_scale`, `chem_time_scale` and `time_scale` in
  `.affect/config.json` to match how often your agents run.
- The parameters are not fitted to human data. `eval/sim.py` in the repository checks a mechanism,
  not realism. To validate: log `.affect/*.log.jsonl`, have blind raters or a
  judge model score transcripts with and without the core for believability
  and consistency, and compare thread-share entropy against a human forum.
- No circadian rhythm, no bodily needs, no trait change.
