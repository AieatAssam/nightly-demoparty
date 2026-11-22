#!/usr/bin/env python3
# Copyright 2026 Aieat Assam
# SPDX-License-Identifier: Apache-2.0
"""affect_core: a pluggable emotional core for LLM agents. Stdlib only.

Five coupled layers, each on its own timescale:

  neurochemistry  minutes-hours  dopamine, noradrenaline, serotonin, cortisol,
                                 oxytocin, opioids (functional abstractions)
  emotions        minutes-hours  15 discrete emotions from cognitive appraisal
  mood            hours-days     Pleasure/Arousal/Dominance vector
  sentiments      days-months    learned likes, dislikes and cravings
  personality     fixed          Big Five, sets every baseline and gain

references/research.md maps each mechanism to its source and says which numbers come
from the literature and which are tunable design choices.

Use as a library (EmotionalCore) or as a CLI (`affect_core.py -h`).
"""
from __future__ import annotations

import argparse
import hashlib
from html import escape
try:
    import fcntl
except ImportError:  # Windows: no advisory locking, single-writer only
    fcntl = None
import importlib.util
import json
import math
import os
import random
import re
import sys
import time
import uuid
from pathlib import Path

VERSION = "0.2.1"

# name: (P, A, D, half_life_hours, valence)
# PAD coordinates follow the OCC->PAD mapping used in ALMA (approximate);
# interest, boredom and surprise are non-OCC extensions.
# Half-life ORDER follows Verduyn & Lavrijsen (2015); absolute values are tunable.
EMOTIONS = {
    "joy":            (0.40, 0.20, 0.10, 4.0, 1),
    "distress":       (-0.40, -0.20, -0.50, 8.0, -1),
    "hope":           (0.20, 0.20, -0.10, 6.0, 1),
    "fear":           (-0.64, 0.60, -0.43, 1.0, -1),
    "relief":         (0.20, -0.30, 0.40, 1.0, 1),
    "disappointment": (-0.30, 0.10, -0.40, 4.0, -1),
    "pride":          (0.40, 0.30, 0.30, 4.0, 1),
    "shame":          (-0.30, 0.10, -0.60, 1.0, -1),
    "admiration":     (0.50, 0.30, -0.20, 3.0, 1),
    "reproach":       (-0.30, -0.10, 0.40, 4.0, -1),
    "gratitude":      (0.40, 0.20, -0.30, 3.0, 1),
    "anger":          (-0.51, 0.59, 0.25, 3.0, -1),
    "interest":       (0.30, 0.40, 0.10, 2.0, 1),
    "boredom":        (-0.20, -0.60, -0.10, 1.0, -1),
    "surprise":       (0.10, 0.60, -0.10, 0.3, 0),
}

# Private framing and attention cues grounded in the current appraisal.
COGNITIVE_CUES = {
    "joy": "what went well and what helped may stand out",
    "distress": "the setback and what remains possible may stand out",
    "hope": "signs of progress and what still depends on the outcome may stand out",
    "fear": "possible downsides and gaps in what you know may stand out",
    "relief": "the signs that the feared outcome has passed may stand out",
    "disappointment": "the gap between the expected and actual outcome may stand out",
    "pride": "your contribution and what you learned may stand out",
    "shame": "your own misstep and how it might be perceived may stand out",
    "admiration": "what the other person did well and what you can learn from it may stand out",
    "reproach": "the conduct and the standard it appeared to breach may stand out",
    "gratitude": "the help you received and why it mattered may stand out",
    "anger": "the apparent obstacle and who seems responsible may stand out",
    "interest": "what remains unexplained and what could clarify it may stand out",
    "boredom": "repetition and the lack of new information may stand out",
    "surprise": "the gap between what you expected and what happened may stand out",
}

# Functional half-lives (hours) of each neuromodulator's deviation from tonic
# baseline. Cortisol's is close to its plasma half-life; the others are
# behavioural-effect timescales, not plasma kinetics.
CHEM = {"da": 0.5, "ne": 0.3, "sht": 24.0, "cort": 1.5, "oxt": 0.75, "opi": 1.0}

# Cross-talk: how far each neuromodulator's deviation (source) shifts another's
# set point (target). Signs follow the literature (see references/research.md); magnitudes
# are design choices kept small enough that the coupled system stays stable.
COUPLING = {
    ("cort", "ne"): 0.30,    # stress hormones raise arousal (CRH -> locus coeruleus)
    ("cort", "sht"): -0.15,  # stress depresses serotonergic tone
    ("cort", "da"): 0.10,    # acute stress releases dopamine (chronic: see load)
    ("oxt", "cort"): -0.30,  # social buffering of the HPA axis
    ("oxt", "sht"): 0.15,    # social reward recruits serotonin
    ("oxt", "da"): 0.10,     # ... and dopamine
    ("opi", "da"): 0.20,     # opioids disinhibit dopamine neurons
    ("opi", "cort"): -0.15,  # endogenous opioids restrain the HPA axis
    ("sht", "da"): -0.15,    # serotonin-dopamine opponency
    ("sht", "cort"): -0.10,
    ("ne", "da"): 0.10,      # catecholamines co-activate
    ("da", "ne"): 0.10,
}

# Compound emotions: two co-active emotions merge into a third experience.
# The first four are OCC compounds; the rest follow Plutchik-style dyads and
# the mixed-emotions literature. pair: (label, behavioural tendency)
BLENDS = {
    ("joy", "pride"): ("gratification", "quietly pleased with yourself; generous to others"),
    ("distress", "shame"): ("remorse", "want to put it right; apologise once, then fix it"),
    ("admiration", "joy"): ("warm appreciation", "openly appreciative of them"),
    ("distress", "reproach"): ("resentment", "cool and clipped with them; keeping score"),
    ("distress", "joy"): ("bittersweet", "reflective; pleased and wistful at once"),
    ("fear", "hope"): ("suspense", "restless anticipation; keeps checking for news"),
    ("fear", "interest"): ("uneasy fascination", "drawn in while wary; careful questions"),
    ("interest", "surprise"): ("wonder", "wide-open curiosity; wants to understand how"),
    ("admiration", "surprise"): ("awe", "humbled; slows down and takes it seriously"),
    ("joy", "surprise"): ("delight", "spontaneous, exclamatory, wants to share it"),
    ("distress", "surprise"): ("shock", "thrown; needs a moment before responding well"),
    ("anger", "distress"): ("hurt", "stung more than furious; guarded"),
    ("anger", "boredom"): ("irritability", "snappish; low tolerance for repetition"),
    ("anger", "interest"): ("combative engagement", "enjoys the fight; argues in detail"),
    ("anger", "fear"): ("defensiveness", "bristling; over-explains and justifies"),
    ("hope", "interest"): ("eagerness", "leans in; volunteers, proposes experiments"),
    ("joy", "relief"): ("elation", "expansive and talkative"),
    ("admiration", "gratitude"): ("affection", "loyal; takes their side"),
    ("admiration", "interest"): ("inspiration", "drawn to their example; explore and build on what they did"),
    ("admiration", "distress"): ("envy", "impressed and stung; tempted to compete or nitpick"),
    ("boredom", "distress"): ("listlessness", "going through the motions"),
    ("disappointment", "reproach"): ("disillusionment", "expects less of them now"),
    ("interest", "pride"): ("flow", "absorbed and confident; long, focused contributions"),
}

# Lövheim (2012) cube: (serotonin, dopamine, noradrenaline) high/low -> Tomkins affect.
LOVHEIM = {
    (0, 0, 0): "shame/humiliation", (0, 0, 1): "distress/anguish",
    (0, 1, 0): "fear/terror", (0, 1, 1): "anger/rage",
    (1, 0, 0): "contempt/disgust", (1, 0, 1): "surprise/startle",
    (1, 1, 0): "enjoyment/joy", (1, 1, 1): "interest/excitement",
}

# Frijda-style action tendencies, phrased as writing/behaviour guidance.
TENDENCY = {
    "joy": "share and build on others' ideas; a little playful",
    "distress": "pull back; shorter posts; less initiative",
    "hope": "propose next steps; forward-looking",
    "fear": "cautious; hedge; seek reassurance or evidence before committing",
    "relief": "loosen up; lighter tone, maybe humour",
    "disappointment": "terse; lowered expectations; may disengage from this topic",
    "pride": "show your work; stand by your contribution",
    "shame": "repair (own the mistake briefly) or go quiet",
    "admiration": "credit them by name; amplify their idea",
    "reproach": "criticise the action, not the person; cooler tone",
    "gratitude": "thank them specifically; reciprocate",
    "anger": "push back directly on the point; less patience for hedging",
    "interest": "ask probing questions; go deeper; follow the tangent",
    "boredom": "change the subject, start something new, or leave this thread",
    "surprise": "say what you did not expect; re-evaluate out loud",
}

MOOD_OCTANTS = {
    (1, 1, 1): "exuberant", (1, 1, -1): "dependent", (1, -1, 1): "relaxed",
    (1, -1, -1): "docile", (-1, -1, -1): "bored", (-1, -1, 1): "disdainful",
    (-1, 1, -1): "anxious", (-1, 1, 1): "hostile",
}

DEFAULTS = {
    "time_scale": 1.0,            # simulated hours per wall-clock hour
    "emotion_time_scale": 1.0,    # multiplies every emotion half-life
    "chem_time_scale": 1.0,       # multiplies every neuromodulator half-life
    "mood_half_life": 24.0,       # hours, relaxation of mood to its current set point
    "mood_pull_tau": 2.0,         # hours, how fast active emotions drag mood
    "mood_nudge": 0.15,           # immediate mood shift per unit of new emotion
    "opponent_tau": 3.0,          # hours to build the opponent process; it fades 2x slower
    "opponent_gain": 0.25,        # strength of the after-reaction on mood
    "load_half_life": 168.0,      # hours, allostatic load integrator (7 days)
    "liking_half_life": 1440.0,   # hours (60 days); dislikes fade 2x slower
    "wanting_half_life": 336.0,   # hours (14 days)
    "exposure_half_life": 12.0,   # hours, spontaneous recovery from habituation
    "emotion_adaptation_half_life": 1.0,  # hours, recovery from repeated emotional stimulation
    "memory_half_life": 72.0,     # hours, salience decay of emotional memories
    "sleep_gap": 6.0,             # an idle gap this long consolidates the day
    "memory_cap": 30,
    "plugins": [],
}

TRAITS = ("O", "C", "E", "A", "N")
TRAIT_NAMES = {"openness": "O", "conscientiousness": "C", "extraversion": "E",
               "agreeableness": "A", "neuroticism": "N"}


def clamp(x, lo=-1.0, hi=1.0):
    return max(lo, min(hi, float(x)))


def num(d, key, default, lo=-1.0, hi=1.0):
    """Read a number from untrusted input: bad, missing or non-finite -> default."""
    try:
        x = float(d.get(key, default))
    except (TypeError, ValueError):
        return default
    return clamp(x, lo, hi) if math.isfinite(x) else default


def event_identifier(appraisal):
    if "event_id" not in appraisal:
        return None
    value = appraisal["event_id"]
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        raise ValueError("event_id must be a non-empty string of at most 128 characters")
    return value


def _word(i):
    return ("faint", "mild", "moderate", "strong", "intense")[min(4, int(i * 5))]


def baseline_from_traits(t):
    """Big Five -> PAD (Mehrabian 1996). Traits in [-1,1]; N = neuroticism."""
    s = -t["N"]  # emotional stability
    return [
        clamp(0.21 * t["E"] + 0.59 * t["A"] + 0.19 * s),
        clamp(0.15 * t["O"] + 0.30 * t["A"] - 0.57 * s),
        clamp(0.25 * t["O"] + 0.17 * t["C"] + 0.60 * t["E"] - 0.32 * t["A"]),
    ]


def chem_baseline(t):
    """Tonic levels (0..1). Extraversion ~ dopaminergic reward sensitivity
    (Depue & Collins 1999); neuroticism ~ stress reactivity."""
    return {"da": 0.5 + 0.1 * t["E"], "ne": 0.5 + 0.1 * t["N"],
            "sht": 0.5 - 0.1 * t["N"] + 0.05 * t["A"], "cort": 0.3 + 0.1 * t["N"],
            "oxt": 0.4 + 0.1 * t["A"], "opi": 0.5}


def random_persona(agent, seed=None):
    """Deterministic per-agent personality so a population is diverse by default."""
    h = int(hashlib.sha256(f"{agent}:{seed}".encode()).hexdigest()[:12], 16)
    rng = random.Random(h)
    return {"traits": {k: round(clamp(rng.gauss(0, 0.5)), 2) for k in TRAITS},
            "interests": [], "bio": ""}


class EmotionalCore:
    HOOKS = ("pre_appraise", "post_appraise", "pre_context", "post_context",
             "pre_choose", "post_choose", "post_advance", "post_consolidate",
             "pre_turn_context", "pre_turn_update", "post_turn_update")

    def __init__(self, agent, state=None, config=None, persona=None, seed=None):
        self.cfg = {**DEFAULTS, **(config or {})}
        self.hooks = {h: [] for h in self.HOOKS}
        if state:
            self.s = state
        else:
            p = persona or random_persona(agent, seed)
            raw = p.get("traits") if isinstance(p.get("traits"), dict) else {}
            raw = {TRAIT_NAMES.get(str(k).lower(), str(k).upper()): v for k, v in raw.items()}
            unknown = sorted(set(raw) - set(TRAITS))
            if unknown:
                raise ValueError(f"unknown personality traits {unknown}; use O, C, E, A, N "
                                 "(or openness, conscientiousness, extraversion, "
                                 "agreeableness, neuroticism), each -1..1")
            traits = {k: num(raw, k, 0.0) for k in TRAITS}
            base = baseline_from_traits(traits)
            self.s = {
                "version": VERSION, "agent": agent,
                "persona": {"traits": traits, "interests": p.get("interests", []),
                            "bio": p.get("bio", "")},
                "baseline": base, "mood": list(base), "emotions": {},
                "chem": chem_baseline(traits), "stress": 0.0, "load": 0.0, "opp": 0.0,
                "drives": {"novelty": 0.3, "social": 0.3, "fatigue": 0.0},
                "sentiments": {}, "relationships": {}, "threads": {}, "memory": [],
                "t": 0.0, "wall": time.time(),
            }
        self.cb = chem_baseline(self.traits)

    # ---- plumbing ---------------------------------------------------------
    def on(self, hook, fn):
        """Register fn(core, payload) -> payload|None on a named hook."""
        self.hooks[hook].append(fn)
        return fn

    def _run(self, hook, payload):
        for fn in self.hooks[hook]:
            r = fn(self, payload)
            if r is not None:
                payload = r
        return payload

    @property
    def traits(self):
        return self.s["persona"]["traits"]

    def intensity(self, name):
        return self.s["emotions"].get(name, {}).get("i", 0.0)

    def dev(self, k):
        """Neuromodulator level relative to this agent's tonic baseline."""
        return self.s["chem"][k] - self.cb[k]

    def habituation(self, thread):
        """0..1, saturating in exposure (Thompson & Spencer 1966)."""
        e = self.s["threads"].get(str(thread), {}).get("exposure", 0.0)
        return 1.0 - math.exp(-e / 3.0)

    def lovheim(self):
        """Which corner of the Lövheim cube the monoamines currently sit in."""
        return LOVHEIM[tuple(int(self.dev(k) >= 0) for k in ("sht", "da", "ne"))]

    # ---- sentiments: learned likes, dislikes, cravings ---------------------
    def _alpha(self, rec, target):
        a = max(0.05, 0.20 / (1 + 0.15 * rec["n"]))  # attitudes crystallise with experience
        if target < rec["L"]:
            a *= 1.5                                  # bad is stronger than good
        return a

    def liking(self, key):
        """Hedonic evaluation of an object in [-1,1]: consolidated value plus a
        preview of today's not-yet-consolidated episode (peak-end weighted)."""
        rec = self.s["sentiments"].get(key)
        if not rec:
            return 0.0
        ep = rec.get("ep")
        if not ep:
            return rec["L"]
        remembered = 0.5 * (ep["peak"] + ep["end"])           # Kahneman et al. 1993
        a = min(0.5, self._alpha(rec, remembered) * (1 + 0.5 * ep["ar"]))  # arousal aids consolidation
        return clamp(rec["L"] + a * (remembered - rec["L"]))

    def wanting(self, key):
        return self.s["sentiments"].get(key, {}).get("W", 0.0)

    def affinity(self, other):
        return self.liking(f"agent:{other}")

    def interest_phase(self, key):
        """Four-phase model of interest development (Hidi & Renninger 2006)."""
        rec = self.s["sentiments"].get(key)
        if not rec:
            return None
        L, n = self.liking(key), rec["n"]
        if L > 0.5 and n >= 10:
            return "well-developed interest"
        if L > 0.3 and n >= 5 and rec["W"] > 0.2:
            return "emerging interest"
        if L > 0.15 and n >= 2:
            return "maintained interest"
        if L > 0.1:
            return "passing interest"
        return None

    def _experience(self, key, h, arousal, delta):
        rec = self.s["sentiments"].setdefault(key, {"L": 0.0, "W": 0.0, "n": 0, "ep": None})
        ep = rec["ep"] or {"peak": h, "end": h, "ar": arousal, "k": 0}
        if abs(h) > abs(ep["peak"]):
            ep["peak"] = h
        ep["end"], ep["ar"], ep["k"] = h, max(ep["ar"], arousal), ep["k"] + 1
        rec["ep"] = ep
        # Incentive salience ('wanting') is driven by better-than-expected
        # outcomes, separately from liking (Berridge & Robinson).
        if delta > 0:
            rec["W"] = 1 - (1 - rec["W"]) * (1 - 0.4 * delta)
        else:
            rec["W"] *= 1 + 0.12 * delta   # wanting outlives liking

    def consolidate(self):
        """Offline consolidation ('sleep'): commit each object's episode to its
        long-term liking, then apply mere exposure. Call at the end of a session."""
        changed = {}
        for key, rec in self.s["sentiments"].items():
            ep = rec.get("ep")
            if not ep:
                continue
            L = self.liking(key)
            rec["n"] += 1
            if L >= -0.1:
                # Mere exposure: familiarity breeds mild liking with diminishing
                # returns; massed over-exposure satiates (inverted U).
                L += 0.04 * math.exp(-rec["n"] / 6.0)
                L -= min(0.08, 0.01 * max(0, ep["k"] - 6))
            changed[key] = round(L - rec["L"], 3)
            rec["L"], rec["ep"] = clamp(L), None
        self._run("post_consolidate", changed)
        return changed

    # ---- time -------------------------------------------------------------
    def advance(self, hours):
        """Clear neuromodulators, decay emotions, drift mood, grow drives."""
        if hours <= 0:
            return
        s, c, t = self.s, self.cfg, self.traits
        ch, cb = s["chem"], self.cb
        if hours >= c["sleep_gap"]:
            self.consolidate()
        steps = max(1, min(48, math.ceil(hours / 0.5)))
        h = hours / steps
        for _ in range(steps):
            # 1. HPA axis: the stress drive converts to cortisol with a lag, so
            #    cortisol peaks after the stressor rather than with it.
            made = s["stress"] * (1 - 0.5 ** (h / 0.4))
            s["stress"] -= made
            ch["cort"] = min(1.0, ch["cort"] + 0.8 * made)
            # Each modulator relaxes to a set point that the others shift
            # (cross-talk); chronic load depresses serotonin and dopamine.
            devs = {k: ch[k] - cb[k] for k in CHEM}
            for k, hl in CHEM.items():
                tgt = cb[k] + sum(w_ * devs[src] for (src, dst), w_ in COUPLING.items() if dst == k)
                tgt -= {"sht": 0.25, "da": 0.20}.get(k, 0.0) * s["load"]
                tgt = clamp(tgt, 0, 1)
                ch[k] = tgt + (ch[k] - tgt) * 0.5 ** (h / (hl * c["chem_time_scale"]))
            # Allostatic load: slow integrator of excess cortisol (McEwen 1998).
            s["load"] += (max(0.0, self.dev("cort")) - s["load"]) * (
                1 - 0.5 ** (h / c["load_half_life"]))
            # 2. emotions: exponential decay; slower for neurotic agents, under
            #    cortisol, and for strong negative emotions (rumination).
            for name in list(s["emotions"]):
                e = s["emotions"][name]
                hl, val = EMOTIONS[name][3] * c["emotion_time_scale"], EMOTIONS[name][4]
                if val < 0:
                    hl *= (1.0 + 0.5 * t["N"]) * (1.0 + 0.5 * max(0.0, self.dev("cort")))
                    if e["i"] > 0.6:
                        hl *= 1.3
                e["i"] *= 0.5 ** (h / hl)
                if e["i"] < 0.02:
                    del s["emotions"][name]
            tot = sum(e["i"] for e in s["emotions"].values())
            # 3. opponent process (Solomon & Corbit 1974): a slow process tracks
            #    current hedonic tone; when the emotion ends it is what remains,
            #    with the opposite sign (comedown after a high, relief after stress).
            a = sum(e["i"] * EMOTIONS[n][0] for n, e in s["emotions"].items())
            growing = abs(a) > abs(s["opp"]) and a * s["opp"] >= 0
            tau = c["opponent_tau"] * (1.0 if growing else 2.0)
            s["opp"] += (a - s["opp"]) * (1 - math.exp(-h / tau))
            after = s["opp"] - a if (not growing and a * s["opp"] >= 0) else 0.0
            # 4. Mood is drawn toward the active emotional centre. The ALMA
            #    same-octant push has limited reach so sustained input settles.
            S = min(1.0, tot)
            m = s["mood"]
            if tot > 0:
                cen = [sum(e["i"] * EMOTIONS[n][k] for n, e in s["emotions"].items()) / tot
                       for k in range(3)]
                k_ = 1.0 - math.exp(-h / c["mood_pull_tau"])
                same = all((m[i] >= 0) == (cen[i] >= 0) for i in range(3))
                beyond = sum(x * x for x in m) > sum(x * x for x in cen)
                for i in range(3):
                    if same and beyond:
                        push_limit = clamp(1.3 * cen[i])
                        remaining = push_limit - m[i]
                        if remaining * cen[i] > 0:
                            m[i] += k_ * S * remaining
                    else:
                        m[i] += k_ * S * (cen[i] - m[i])
            d = {k: self.dev(k) for k in CHEM}
            setp = [
                s["baseline"][0] + 0.6 * d["sht"] + 0.5 * d["opi"] + 0.2 * d["oxt"]
                - 0.6 * d["cort"] - 0.4 * s["load"],
                s["baseline"][1] + 0.9 * d["ne"] + 0.4 * d["da"] + 0.2 * d["cort"],
                s["baseline"][2] + 0.5 * d["sht"] + 0.4 * d["da"] - 0.5 * d["cort"]
                - 0.2 * s["load"],
            ]
            m[0] -= (1 - math.exp(-h / c["mood_pull_tau"])) * c["opponent_gain"] * after
            r = 1.0 - 0.5 ** (h / c["mood_half_life"])
            for i in range(3):
                m[i] = clamp(m[i] + r * (1.0 - S) * (clamp(setp[i]) - m[i]))
            # 5. drives (homeostatic): novelty hunger and social need build up,
            #    fatigue recovers.
            dr = s["drives"]
            dr["novelty"] = 1 - (1 - dr["novelty"]) * math.exp(-h * 0.05 * (1 + 0.5 * t["O"]))
            dr["social"] = 1 - (1 - dr["social"]) * math.exp(-h * 0.04 * (1 + 0.6 * t["E"]))
            dr["fatigue"] *= 0.5 ** (h / 3.0)
        # 6. slow layers (exact exponentials, no sub-stepping needed).
        for rec in s["sentiments"].values():
            hl = c["liking_half_life"] * min(4.0, 1 + 0.1 * rec["n"])
            rec["L"] *= 0.5 ** (hours / (hl * (2.0 if rec["L"] < 0 else 1.0)))
            rec["W"] *= 0.5 ** (hours / c["wanting_half_life"])
        factor = 0.5 ** (hours / c["liking_half_life"])
        for rec in s.get("relationships", {}).values():
            rec["affection"] = clamp(num(rec, "affection", 0.0) * factor)
            rec["guardedness"] = clamp(num(rec, "guardedness", 0.0, 0, 1) * factor, 0, 1)
        for th in s["threads"].values():
            th["exposure"] *= 0.5 ** (hours / c["exposure_half_life"])
        adaptation = s.get("emotion_adaptation", {})
        recovery = 0.5 ** (hours / c["emotion_adaptation_half_life"])
        for name, level in list(adaptation.items()):
            remaining = level * recovery
            if remaining < 0.01:
                del adaptation[name]
            else:
                adaptation[name] = remaining
        s["t"] += hours
        self._run("post_advance", hours)

    # ---- appraisal --------------------------------------------------------
    def appraise(self, ap):
        """Turn an appraisal of one event into emotions. Returns {emotion: intensity}.

        ap keys (all optional except event):
          event str, event_id stable str, source agent-id, thread id, topics [str],
          relevance 0..1, congruence -1..1, novelty 0..1,
          agency self|other|circumstance, praiseworthiness -1..1,
          control 0..1, certainty 0..1,
          perceived_emotion {label, intensity}  (drives contagion),
          relationship {type: "romantic", affection: -1..1,
                        trust_violation: 0..1} (explicit relationship evidence)
        """
        s, t, ch = self.s, self.traits, self.s["chem"]
        supplied_id = event_identifier(ap)
        if supplied_id in s.get("seen_event_ids", ()):
            return {}
        ap = self._run("pre_appraise", dict(ap))
        event_id = supplied_id or event_identifier(ap)
        if event_id and event_id in s.get("seen_event_ids", ()):
            return {}
        rel = num(ap, "relevance", 0.5, 0, 1)
        cong = num(ap, "congruence", 0.0)
        nov = num(ap, "novelty", 0.3, 0, 1)
        praise = num(ap, "praiseworthiness", 0.0)
        control = num(ap, "control", 0.5, 0, 1)
        cert = num(ap, "certainty", 1.0, 0, 1)
        agency = ap.get("agency") if ap.get("agency") in ("self", "other") else "circumstance"
        src, th = ap.get("source"), ap.get("thread")
        src = str(src) if src not in (None, "", s["agent"]) else None
        th = str(th) if th is not None else None
        tp = ap.get("topics") or []
        tp = [tp] if isinstance(tp, str) else (tp if isinstance(tp, list) else [])
        topics = [x.strip().lower()[:60] for x in tp if isinstance(x, str) and x.strip()][:8]
        aff = self.affinity(src) if src else 0.0
        # Explicit relationship evidence only: generic praise or warmth must
        # never be interpreted as romance.
        relation = ap.get("relationship")
        if src and isinstance(relation, dict) and relation.get("type") == "romantic":
            rec = s.setdefault("relationships", {}).setdefault(
                src, {"affection": 0.0, "guardedness": 0.0})
            affection = num(relation, "affection", 0.0)
            violation = num(relation, "trust_violation", 0.0, 0, 1)
            if affection:
                old = num(rec, "affection", 0.0)
                rec["affection"] = clamp(old + 0.25 * (affection - old))
            if violation:
                old = num(rec, "guardedness", 0.0, 0, 1)
                rec["guardedness"] = clamp(old + 0.35 * violation * (1 - old), 0, 1)
        hab = self.habituation(th) if th else 0.0
        nov_eff = nov * (1 - 0.6 * hab)
        out = {}

        def add(name, x):
            if x > 0.03:
                out[name] = max(out.get(name, 0.0), min(1.0, x))

        # Outcome emotions (OCC: consequences of events; prospect-based if
        # uncertain). Unexpected outcomes feel stronger (Mellers et al. 1997).
        amp = 0.75 + 0.5 * nov_eff
        if cert >= 0.7:
            if cong > 0:
                add("joy", rel * cong * amp)
            elif cong < 0:
                add("distress", rel * -cong * (1 - 0.4 * control) * amp)
            resolution = rel * abs(cong)
            if resolution > 0.03:
                for name, disconfirmed in (("fear", "relief"), ("hope", "disappointment")):
                    prospect = s["emotions"].get(name)
                    if not prospect or (prospect.get("thread") and prospect["thread"] != th):
                        continue
                    if prospect["i"] > 0.3 and (cong > 0) == (name == "fear"):
                        add(disconfirmed, prospect["i"] * resolution)
                    prospect["i"] *= 1 - 0.6 * resolution
        else:
            if cong > 0:
                add("hope", rel * cong)
            elif cong < 0:
                add("fear", rel * -cong * (1 - 0.7 * control))
        # Attribution emotions (OCC: actions of agents). High coping potential
        # turns a blameworthy obstruction into anger rather than fear (Scherer).
        w = 0.4 + 0.6 * rel
        if agency == "other":
            if praise > 0:
                add("admiration", praise * w * (1 + 0.3 * aff))
                if cong > 0:
                    add("gratitude", math.sqrt(praise * cong) * rel * (1 + 0.3 * aff))
            elif praise < 0:
                add("reproach", -praise * w * (1 - 0.3 * aff))
                if cong < 0:
                    add("anger", math.sqrt(praise * cong) * rel * (0.5 + 0.5 * control)
                        * (1 - 0.3 * aff))
        elif agency == "self":
            add("pride" if praise > 0 else "shame", abs(praise) * w)
        # Epistemic emotions. Interest needs novelty AND a sense you can cope
        # with it (Silvia 2005); habituation blunts both.
        add("surprise", (nov_eff - 0.4) * 1.2)
        add("interest", nov_eff * (0.4 + 0.6 * control) * (0.8 + 0.3 * t["O"])
            * (1 + 0.5 * self.dev("da") - 0.5 * s["load"]))
        add("boredom", (1 - nov) * (1 - rel) * 0.6 + 0.5 * max(0.0, hab - 0.3))
        # Modulation by trait, mood and neurochemistry.
        P = s["mood"][0]
        transfer = 1 + 0.5 * max(0.0, self.dev("ne"))   # excitation transfer (Zillmann 1971)
        low_sht = max(0.0, -self.dev("sht"))
        for name in list(out):
            val = EMOTIONS[name][4]
            g = transfer
            if val > 0:
                g *= (1 + 0.35 * t["E"]) * (1 + 0.3 * P)
                g *= 1 + 0.5 * self.dev("da") + 0.4 * self.dev("opi")
            elif val < 0:
                g *= (1 + 0.35 * t["N"]) * (1 - 0.3 * P)
                g *= 1 + 0.8 * max(0.0, self.dev("cort")) + 0.6 * low_sht + 0.5 * s["load"]
            if name == "anger":
                g *= 1 + 0.8 * low_sht               # low serotonin, short fuse
            x = out[name] * max(0.0, g)
            # Stacked gains saturate softly instead of pinning at the ceiling.
            out[name] = x if x <= 0.6 else 0.6 + 0.3 * math.tanh((x - 0.6) / 0.3)
        # Boredom does not coexist with being strongly moved by something.
        if "boredom" in out:
            out["boredom"] *= 1 - max((v for k, v in out.items() if k != "boredom"), default=0.0)
        # Emotional contagion (Hatfield et al. 1994), stronger from liked sources.
        pe = ap.get("perceived_emotion")
        pe = pe if isinstance(pe, dict) else {}
        if pe.get("label") in EMOTIONS:
            susc = clamp(0.40 + 0.15 * t["A"] + 0.10 * t["N"], 0, 1) * (0.6 + 0.4 * aff)
            add(pe["label"], num(pe, "intensity", 0.5, 0, 1) * susc)
        # Transition inertia: a strong current emotion resists its opposite and
        # is itself dented by it (valence-consistent transitions are likelier).
        cur = [(e["i"], n) for n, e in s["emotions"].items()
               if e["i"] > 0.5 and EMOTIONS[n][4] != 0]
        if cur:
            di, dn = max(cur)
            dval = EMOTIONS[dn][4]
            opp = [n for n in out if EMOTIONS[n][4] == -dval]
            for n in opp:
                out[n] *= 1 - 0.4 * di
            if opp:
                s["emotions"][dn]["i"] *= 1 - 0.3 * max(out[n] for n in opp)

        # Rapid sequences that evoke the same emotion lose force across
        # sources and topics. Recovery follows elapsed time.
        adaptation = s.setdefault("emotion_adaptation", {})
        for name, x in out.items():
            level = adaptation.get(name, 0.0)
            out[name] = x * (1 - 0.45 * level)
            adaptation[name] = level + (1 - level) * 0.25 * x

        # Reinforcement approaches a ceiling set by the strength of the new
        # stimulus. A stronger existing emotion still decays on its own clock.
        cause = str(ap.get("event", ""))[:140]
        for name, x in out.items():
            e = s["emotions"].setdefault(name, {"i": 0.0, "target": None, "cause": ""})
            directed = name in ("anger", "reproach", "admiration", "gratitude")
            target = src if directed else None
            same_subject = e.get("thread") == th and e["target"] == target
            if x >= e["i"] or (same_subject and x >= 0.5 * e["i"]):
                e.update(target=target, source=src, cause=cause, thread=th)
            ceiling = x + 0.3 * (1 - x) * math.sqrt(x)
            e["i"] = max(x, e["i"] + x * max(0.0, ceiling - e["i"]))
        for i in range(3):
            impulse = sum(x * EMOTIONS[n][i] for n, x in out.items())
            if impulse:
                base, mood = s["baseline"][i], s["mood"][i]
                headroom = 1 - math.copysign(1.0, impulse) * base
                target = base + headroom * math.tanh(impulse)
                if (target - mood) * impulse > 0:
                    s["mood"][i] = clamp(mood + self.cfg["mood_nudge"] * (target - mood))

        # Hedonic experience, reward prediction error, and learning.
        g_ = out.get
        hed = clamp(sum(x * EMOTIONS[n][0] for n, x in out.items()) / 0.5)
        other = 0.5 if agency == "other" else 0.0
        social = clamp(g_("gratitude", 0) + g_("admiration", 0) + other * g_("joy", 0)
                       - g_("anger", 0) - g_("reproach", 0) - other * g_("distress", 0))
        # When someone else caused it, most of the credit or blame goes to them
        # and less rubs off on the subject matter.
        objs = {f"topic:{x}": hed * (0.6 if agency == "other" else 1.0) for x in topics}
        if th:
            objs[f"thread:{th}"] = hed
        if src:
            # Direct treatment if there was any; otherwise mere co-occurrence
            # with a good or bad event still rubs off (evaluative conditioning).
            objs[f"agent:{src}"] = 0.8 * social if abs(social) > 0.03 else 0.3 * hed
        expected = sum(self.liking(k) for k in objs) / len(objs) if objs else 0.0
        delta = clamp(hed - expected)                 # reward prediction error
        arousal = max(out.values(), default=0.0)
        for k, hk in objs.items():
            self._experience(k, hk, arousal, clamp(hk - self.liking(k)))

        # Neuromodulator release.
        oxt_buffer = 1 - 0.5 * max(0.0, self.dev("oxt"))   # social buffering of stress
        soc_eval = 1.0 if (agency == "other" and praise < 0) or "shame" in out else 0.0
        ch["da"] = clamp(ch["da"] + 0.35 * delta + 0.2 * nov_eff, 0, 1)
        ch["ne"] = clamp(ch["ne"] + 0.35 * nov_eff + 0.25 * abs(delta)
                         + 0.4 * max(g_("fear", 0), g_("anger", 0)), 0, 1)
        # Cortisol responds to uncontrollable and social-evaluative threat, not
        # to every negative event (Dickerson & Kemeny 2004).
        stress = rel * max(0.0, -cong) * (1 - control) * (0.6 + 0.6 * soc_eval) * oxt_buffer
        s["stress"] += max(0.0, 1 - s["stress"]) * min(1.0, stress)
        ch["oxt"] = clamp(ch["oxt"] + 0.5 * (g_("gratitude", 0) + g_("admiration", 0))
                          * (0.6 + 0.4 * max(0.0, aff)), 0, 1)
        ch["opi"] = clamp(ch["opi"] + 0.4 * (g_("joy", 0) + g_("relief", 0) + g_("pride", 0)), 0, 1)
        ch["sht"] = clamp(ch["sht"] + 0.06 * (g_("pride", 0) + g_("gratitude", 0) + g_("joy", 0))
                          - 0.06 * (g_("shame", 0) + g_("distress", 0)), 0, 1)

        if src:
            s["drives"]["social"] *= 0.9
        if th:
            s["threads"].setdefault(th, {"exposure": 0.0})["exposure"] += 0.15
        s["drives"]["novelty"] = clamp(s["drives"]["novelty"] - 0.3 * nov_eff, 0, 1)
        # Emotion-tagged episodic memory; arousal and stress hormones at
        # encoding strengthen it (McGaugh 2004).
        if out:
            top = max(out, key=out.get)
            if out[top] >= 0.35:
                boost = 1 + max(0.0, self.dev("ne")) + max(0.0, self.dev("cort"))
                s["memory"] = [m for m in s["memory"]
                               if (m["event"], m.get("source"), m.get("thread")) != (cause, src, th)]
                s["memory"].append({"t": s["t"], "event": cause, "emotion": top,
                                    "i": round(min(1.5, out[top] * boost), 3),
                                    "source": src, "thread": th})
                if len(s["memory"]) > self.cfg["memory_cap"]:
                    s["memory"].sort(key=self._salience, reverse=True)
                    del s["memory"][self.cfg["memory_cap"]:]
        if event_id:
            seen = s.setdefault("seen_event_ids", [])
            seen.append(event_id)
            del seen[:-256]
        self._run("post_appraise", {"appraisal": ap, "emotions": out, "rpe": delta})
        return out

    def _salience(self, m):
        return m["i"] * 0.5 ** ((self.s["t"] - m["t"]) / self.cfg["memory_half_life"])

    # ---- attention: where to go next ---------------------------------------
    def _topic_match(self, th):
        if th.get("topic_match") is not None:
            return num(th, "topic_match", 0.5, 0, 1)
        ints = [w.lower() for w in self.s["persona"]["interests"]]
        if not ints:
            return 0.5
        tags = th.get("tags") if isinstance(th.get("tags"), list) else []
        text = (str(th.get("title") or "") + " " + " ".join(map(str, tags))).lower()
        hits = sum(1 for w in ints if w in text)
        return 0.3 if hits == 0 else min(1.0, 0.6 + 0.2 * hits)

    def choose(self, threads, rng=None, allow_new=True, allow_skip=True):
        """Pick reply / new_thread / skip by sampling a softmax over affective
        utility. threads: [{id, title?, tags?, topic_match?, recent_posts?,
        n_posts?, participants?, last_activity_hours?}]"""
        threads = [th for th in (threads or []) if isinstance(th, dict) and th.get("id") is not None]
        threads = list({str(th["id"]): th for th in threads}.values())   # drop duplicate ids
        threads = self._run("pre_choose", threads)
        rng = rng or random.Random()
        s, t, d = self.s, self.traits, self.s["drives"]
        P, A, D = s["mood"]
        E01 = 0.5 + 0.5 * t["E"]
        da, ne, cort, oxt = (self.dev(k) for k in ("da", "ne", "cort", "oxt"))
        opts = {}
        for th in threads:
            tid = str(th["id"])
            hab = self.habituation(tid)
            crowd = 1 - math.exp(-num(th, "recent_posts", num(th, "n_posts", 0, 0, 1e6), 0, 1e6) / 15.0)
            parts = th.get("participants") if isinstance(th.get("participants"), list) else []
            parts = [p for p in parts if isinstance(p, str) and p != s["agent"]]
            affs = [self.affinity(p) for p in parts]
            tags = th.get("tags") if isinstance(th.get("tags"), list) else []
            keys = [f"thread:{tid}"] + [f"topic:{x.strip().lower()}" for x in tags if isinstance(x, str)]
            tl = [self.liking(k) for k in keys[1:]]
            c = {
                "topic interest": 1.2 * self._topic_match(th) + 0.8 * (sum(tl) / len(tl) if tl else 0),
                "craving": 0.8 * max(self.wanting(k) for k in keys),
                "novelty hunger": 1.0 * d["novelty"] * (1 - hab) * (1 + 0.6 * da),
                "tired of this thread": -1.8 * hab,
                "crowd": crowd * (0.9 * d["social"] * E01 - 0.7 * (1 - E01) - 0.5 * d["fatigue"]),
                "people I like here": 0.8 * (sum(affs) / len(affs) if affs else 0)
                                      * (0.5 + d["social"]) * (1 + max(0.0, oxt)),
                "how it felt last time": 0.6 * self.liking(keys[0]),
                "stale": -0.3 * min(1.0, num(th, "last_activity_hours", 0, 0, 1e6) / 48.0),
            }
            if affs and min(affs) < -0.3:
                foe = parts[affs.index(min(affs))]
                ang = self.intensity("anger") if s["emotions"].get("anger", {}).get("target") == foe else 0
                if D > 0 or ang > 0.4:
                    c["unfinished argument"] = 0.4 + 0.6 * ang
                else:
                    c["avoiding someone"] = 0.8 * min(affs)
            opts[("reply", tid)] = c
        if allow_new:
            opts[("new_thread", None)] = {
                "base": -0.2,
                "novelty hunger": 1.0 * d["novelty"] * (0.6 + 0.4 * t["O"]) * (1 + 0.6 * da),
                "confidence": 0.4 * D,
                "boredom": 0.6 * self.intensity("boredom"),
                "fatigue": -0.5 * d["fatigue"],
            }
        if allow_skip:
            opts[("skip", None)] = {
                "base": -0.3,
                "fatigue": 1.2 * d["fatigue"],
                "low energy": 0.5 * -A,
                "withdrawn": 0.6 * max(self.intensity("distress"), self.intensity("shame")),
                "stressed": 0.8 * max(0.0, cort) + 0.6 * s["load"],
                "wants company": -0.4 * d["social"],
            }
        if not opts:
            return {"action": "skip", "thread": None, "why": [], "probs": {}}
        # Aroused agents are less predictable; tonic noradrenaline shifts
        # exploit -> explore (Aston-Jones & Cohen 2005).
        temp = 0.35 + 0.4 * (0.5 + 0.5 * A) + 0.4 * max(0.0, ne)
        u = {k: sum(v.values()) for k, v in opts.items()}
        mx = max(u.values())
        w = {k: math.exp((x - mx) / temp) for k, x in u.items()}
        z = sum(w.values())
        r, acc, pick = rng.random() * z, 0.0, None
        for k, x in w.items():
            acc += x
            if r <= acc:
                pick = k
                break
        pick = pick or k
        why = [n for n, v in sorted(opts[pick].items(), key=lambda kv: -kv[1])
               if v > 0.15 and n != "base"][:2]
        res = {"action": pick[0], "thread": pick[1], "why": why,
               "probs": {(k[1] or k[0]): round(x / z, 3) for k, x in w.items()}}
        return self._run("post_choose", res)

    def acted(self, kind="reply", thread=None):
        """Call after the agent actually posts. kind: reply|new_thread|skip."""
        d = self.s["drives"]
        if kind == "skip":
            return
        if thread is not None:
            hab = self.habituation(thread)
            self.s["threads"].setdefault(str(thread), {"exposure": 0.0})["exposure"] += 1.0
            d["novelty"] *= 0.5 + 0.45 * hab
        if kind == "new_thread":
            d["novelty"] *= 0.3
        d["social"] *= 0.6
        d["fatigue"] = 1 - (1 - d["fatigue"]) * 0.75

    def turn_context(self, prompt="", thread=None, with_agents=(), brief=False):
        """Let a trusted host identify participants before rendering private context."""
        turn = self._run("pre_turn_context", {"prompt": prompt, "thread": thread,
                                              "with_agents": with_agents})
        return self.context(turn["with_agents"], brief=brief)

    def finish_turn(self, turn_id, kind="reply", thread=None, appraisals=(), message=""):
        """Apply new outcomes and participation once per recent host turn ID."""
        if not isinstance(turn_id, str) or not turn_id.strip() or len(turn_id) > 256:
            raise ValueError("finish-turn requires a turn_id of 1 to 256 characters")
        recent = self.s.get("finished_turns", [])
        if turn_id in recent:
            return {"updated": False}
        update = self._run("pre_turn_update", {"turn_id": turn_id, "kind": kind,
                           "thread": thread, "appraisals": appraisals, "message": message})
        kind, events = update["kind"], update["appraisals"]
        if kind not in ("reply", "skip", "new_thread"):
            raise ValueError("unknown turn action")
        if not isinstance(events, (list, tuple)) or not all(
                isinstance(x, dict) and isinstance(x.get("event"), str) and x["event"].strip()
                for x in events):
            raise ValueError("appraisals must be a list of events with non-empty descriptions")
        for event in events:
            event_identifier(event)
        elicited = [self.appraise(x) for x in events]
        self.acted(kind, update["thread"])
        self.consolidate()
        self.s["finished_turns"] = (recent + [turn_id])[-256:]
        result = {"updated": True, "elicited": elicited, "turn_id": turn_id}
        return self._run("post_turn_update", result)

    # ---- expression -------------------------------------------------------
    def mood_label(self):
        m = self.s["mood"]
        mag = math.sqrt(sum(x * x for x in m)) / math.sqrt(3)
        if mag < 0.08:
            return "neutral"
        deg = "slightly" if mag < 0.25 else "moderately" if mag < 0.5 else "strongly"
        return f"{deg} {MOOD_OCTANTS[tuple(1 if x >= 0 else -1 for x in m)]}"

    def shown(self, name):
        """Expressed intensity after display-rule suppression (Gross 1998).
        Conscientious and agreeable agents mask negative emotion more."""
        i = self.intensity(name)
        if EMOTIONS[name][4] >= 0:
            return i
        sup = clamp(0.25 + 0.2 * self.traits["C"] + 0.15 * self.traits["A"], 0, 0.7)
        return i * (1 - sup)

    def blends(self, floor=0.25):
        """Compound emotions from pairs that are active together.
        Returns [(label, intensity, tendency, (a, b))], strongest first."""
        res = []
        for (a, b_), (label, tend) in BLENDS.items():
            ia, ib = self.intensity(a), self.intensity(b_)
            if min(ia, ib) < floor or min(ia, ib) == 0:
                continue
            first, second = self.s["emotions"][a], self.s["emotions"][b_]
            # Separate episodes can colour the same mood without implying a
            # shared motive (e.g. admiration here and distress elsewhere).
            if any(first.get(key) and second.get(key) and first[key] != second[key]
                   for key in ("thread", "target")):
                continue
            if label == "inspiration" and (not first.get("source") or
                    first.get("source") != second.get("source")):
                continue
            res.append((label, math.sqrt(ia * ib), tend, (a, b_)))
        return sorted(res, key=lambda r: -r[1])

    def body(self):
        """Felt-sense phrases from the neurochemical mix. Combinations are read
        first: the same chemical means different things in different company."""
        s, b = self.s, []
        hi = {k: self.dev(k) > 0.15 for k in CHEM}
        lo = {k: self.dev(k) < -0.08 for k in CHEM}
        used = set()

        def mix(keys, text):
            if not used & set(keys):
                b.append(text)
                used.update(keys)

        if hi["cort"] and hi["ne"]:
            mix(("cort", "ne"), "tense and keyed up, braced for trouble")
        if hi["cort"] and lo["da"]:
            mix(("cort", "da"), "defeated, little fight left")
        if hi["da"] and hi["ne"]:
            mix(("da", "ne"), "excited and driven, hard to sit still")
        if hi["da"] and lo["sht"]:
            mix(("da", "sht"), "impulsive, inclined to act before thinking")
        if hi["oxt"] and hi["opi"]:
            mix(("oxt", "opi"), "an affectionate glow, at ease with these people")
        if hi["ne"] and lo["sht"]:
            mix(("ne", "sht"), "jumpy and irritable")
        if hi["opi"] and hi["da"]:
            mix(("opi", "da"), "enjoying this and wanting more of it")
        single = (("cort", hi, "stressed and on edge"), ("ne", hi, "wired, alert"),
                  ("da", hi, "motivated, seeking"), ("da", lo, "flat, hard to care"),
                  ("sht", lo, "short fuse, impatient"), ("oxt", hi, "warm and trusting"),
                  ("opi", hi, "content"))
        for k, table, text in single:
            if table[k] and k not in used:
                b.append(text)
                used.add(k)
        if self.dev("ne") > 0.42:
            b.append("too wound up to focus well")   # inverted-U of arousal
        if s["load"] > 0.15:
            b.append("worn down by sustained stress")
        quiet = sum(e["i"] for e in s["emotions"].values()) < 0.3
        if quiet and s["opp"] > 0.12:
            b.append("comedown after an earlier high")
        elif quiet and s["opp"] < -0.12:
            b.append("lighter now the bad part has passed")
        return b

    def tastes(self, with_agents=(), limit=4):
        likes, dislikes, pulls, people = [], [], [], []
        for key, rec in self.s["sentiments"].items():
            kind, name = key.split(":", 1)
            L = self.liking(key)
            if kind == "agent":
                if abs(L) >= 0.15 and (not with_agents or name in with_agents):
                    people.append((abs(L), f"{name} ({'warm' if L > 0 else 'cool'} {L:+.2f})"))
                continue
            label = name if kind == "topic" else f"thread {name}"
            ph = self.interest_phase(key) if kind == "topic" else None
            # One encounter is an impression, not yet a taste, unless it was strong.
            bar = 0.2 if rec["n"] >= 1 else 0.35
            if L >= bar:
                likes.append((L, f"{label} ({ph})" if ph else label))
            elif L <= -bar:
                dislikes.append((-L, label))
            if rec["W"] > 0.4 and L < 0.1:
                pulls.append((rec["W"], label))
        top = lambda xs: [x for _, x in sorted(xs, reverse=True)[:limit]]
        return top(likes), top(dislikes), top(pulls), top(people)

    def context(self, with_agents=(), max_emotions=3, brief=False):
        """The block to inject before the agent's turn (the 'pre hook')."""
        self._run("pre_context", None)
        s = self.s
        P, A, D = s["mood"]
        mood = self.mood_label()
        if not brief:
            mood += f" (pleasure {P:+.2f}, arousal {A:+.2f}, dominance {D:+.2f})"
        L = [f'<affect agent="{escape(s["agent"])}">', f"Mood: {mood}."]
        b = self.body()
        if b:
            L.append("Body: " + "; ".join(b) + ".")
        present = set(with_agents)
        ems = [(n, e) for n, e in s["emotions"].items()
               if not present or not e["target"] or e["target"] in present]
        ems = sorted(ems, key=lambda kv: -kv[1]["i"])[:max_emotions]
        ems = [(n, e) for n, e in ems if e["i"] >= 0.15]
        if ems and not brief:
            L.append("Attention cues are private. Let them shape what you notice while keeping the reply focused on the situation.")
        for n, e in ems:
            tgt = f" toward {e['target']}" if e["target"] else ""
            why = f' because "{e["cause"]}"' if e["cause"] else ""
            feeling = f"- {_word(e['i'])} {n}{tgt}{why}."
            if not brief:
                feeling += f" Tendency: {TENDENCY[n]}."
                sh = self.shown(n)
                if e["i"] - sh > 0.1:
                    feeling += f" Felt {_word(e['i'])}, let about {_word(sh)} show."
                feeling += f" Attention cue: {COGNITIVE_CUES[n]}."
            L.append(feeling)
        if not ems and not brief:
            L.append("- No strong emotion right now.")
        if not brief:
            blends = [blend for blend in self.blends()
                      if all(not present or not s["emotions"][n]["target"]
                             or s["emotions"][n]["target"] in present for n in blend[3])]
            for label, bi, tend, (x, y) in blends[:2]:
                L.append(f"- Together, the {x} and {y} merge into {_word(bi)} {label}: {tend}.")
        d = s["drives"]
        dr = []
        if d["novelty"] > 0.6:
            dr.append("restless for something new")
        if d["social"] > 0.6:
            dr.append("wants company")
        if d["fatigue"] > 0.5:
            dr.append("tired of posting")
        if dr:
            L.append("Drives: " + ", ".join(dr) + ".")
        if not brief:
            st = [
                "energetic, quicker, shorter sentences" if A > 0.25 else
                "slow, measured, low effort to engage" if A < -0.25 else "even pace",
                "warm and generous" if P > 0.25 else
                "curt, few pleasantries" if P < -0.25 else "matter-of-fact",
                "assertive, states positions" if D > 0.25 else
                "tentative, asks rather than asserts" if D < -0.25 else "balanced confidence",
            ]
            L.append("Voice: " + "; ".join(st) + ".")
        likes, dislikes, pulls, people = self.tastes(with_agents)
        if likes:
            L.append("Likes: " + ", ".join(likes) + ".")
        if dislikes:
            L.append("Dislikes: " + ", ".join(dislikes) + ".")
        if pulls:
            L.append("Keeps getting pulled back to (without enjoying it): " + ", ".join(pulls) + ".")
        if people:
            L.append("People: " + ", ".join(people) + ".")
        relations = []
        for name, rec in s.get("relationships", {}).items():
            if name not in present:
                continue
            affection = num(rec, "affection", 0.0)
            guarded = num(rec, "guardedness", 0.0, 0, 1)
            if abs(affection) >= 0.15 or guarded >= 0.15:
                tone = ("loving/attached" if affection >= 0.65 else
                        "affectionate" if affection >= 0.15 else
                        "less affectionate" if affection <= -0.15 else "")
                guard = "guarded" if guarded >= 0.15 else ""
                relations.append(f"{name} ({', '.join(x for x in (tone, guard) if x)})")
        if relations:
            L.append("Romantic relationship context: " + "; ".join(relations) + ".")
        eligible = (m for m in s["memory"] if self._salience(m) > 0.1)
        mem = sorted(eligible, key=lambda m: (m.get("source") in present, self._salience(m)),
                     reverse=True)[:3]
        if mem:
            L.append("Still on your mind: " + "; ".join(
                f'{m["event"]} ({m["emotion"]})' for m in mem) + ".")
        L.append("These are possible impulses. Use the current situation to decide what "
                 "shows. Feelings about someone else can stay in the background. A plain "
                 "answer or a practical gesture can fit. Keep facts and standards of "
                 "evidence steady.")
        # Remembered text may itself contain markup or a lookalike state block.
        L[1:] = [escape(line, quote=False) for line in L[1:]]
        L.append("</affect>")
        return self._run("post_context", "\n".join(L))

    def summary(self):
        """Compact machine-readable snapshot, for logs and dashboards."""
        s = self.s
        return {
            "agent": s["agent"], "t": round(s["t"], 2), "mood_label": self.mood_label(),
            "mood": [round(x, 3) for x in s["mood"]],
            "emotions": {n: round(e["i"], 3) for n, e in s["emotions"].items()},
            "blends": {b[0]: round(b[1], 3) for b in self.blends()},
            "chem": {k: round(v, 3) for k, v in s["chem"].items()},
            "lovheim": self.lovheim(), "stress_drive": round(s["stress"], 3),
            "allostatic_load": round(s["load"], 3), "opponent": round(s["opp"], 3),
            "drives": {k: round(v, 3) for k, v in s["drives"].items()},
            "sentiments": {k: {"liking": round(self.liking(k), 3), "wanting": round(r["W"], 3),
                               "episodes": r["n"]} for k, r in s["sentiments"].items()},
            "relationships": {k: {"affection": round(num(v, "affection", 0.0), 3),
                                  "guardedness": round(num(v, "guardedness", 0.0, 0, 1), 3)}
                              for k, v in s.get("relationships", {}).items()},
        }


# ---- persistence ------------------------------------------------------------
def state_dir(path=None):
    return Path(path or os.environ.get("AFFECT_STATE_DIR", ".affect"))


def load(agent, path=None, seed=None, persona=None):
    d = state_dir(path)
    cfg = {}
    if (d / "config.json").exists():
        cfg = json.loads((d / "config.json").read_text())
    f = d / f"{agent}.json"
    state = json.loads(f.read_text()) if f.exists() else None
    if state is None and persona is None and (d / "personas.json").exists():
        persona = json.loads((d / "personas.json").read_text()).get(agent)
    core = EmotionalCore(agent, state=state, config=cfg, persona=persona, seed=seed)
    for p in core.cfg["plugins"]:  # each plugin file exposes register(core)
        spec = importlib.util.spec_from_file_location(Path(p).stem, p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.register(core)
    return core


def save(core, path=None):
    d = state_dir(path)
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{core.s['agent']}.json"
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(core.s, indent=1))
    tmp.replace(f)


def log(core, path, record):
    """Append-only audit trail: one JSON line per affective event."""
    d = state_dir(path)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / f"{core.s['agent']}.log.jsonl", "a") as fh:
        fh.write(json.dumps({"wall": round(time.time()), **record}) + "\n")


# ---- CLI --------------------------------------------------------------------
def _read_json(arg):
    try:
        if arg in (None, "-"):
            return json.load(sys.stdin)
        if len(arg) < 4096 and os.path.exists(arg):
            return json.loads(Path(arg).read_text())
        return json.loads(arg)
    except ValueError as e:
        sys.exit(f"affect_core: --json is not valid JSON ({e})")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="affect_core", description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["init", "context", "appraise", "choose", "acted",
                                    "tick", "consolidate", "state", "dump", "finish-turn", "claude-hook", "codex-hook", "gemini-hook"])
    ap.add_argument("--agent", default=os.environ.get("AFFECT_AGENT"))
    ap.add_argument("--state-dir", default=None)
    ap.add_argument("--hours", type=float, default=None,
                    help="advance the clock by this many hours instead of using wall time")
    ap.add_argument("--json", default=None, help="JSON string, file path, or - for stdin")
    ap.add_argument("--persona", default=None, help="persona JSON for init")
    ap.add_argument("--with", dest="with_agents", default=os.environ.get("AFFECT_WITH", ""), help="comma-separated agent ids present")
    ap.add_argument("--brief", action="store_true", help="omit mood scores and writing cues from context")
    ap.add_argument("--thread", default=None)
    ap.add_argument("--kind", default="reply", choices=["reply", "new_thread", "skip"])
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args(argv)
    native_host = {"codex-hook": "codex", "gemini-hook": "gemini"}.get(a.cmd)
    if native_host:
        a.agent = a.agent or native_host
        if not a.state_dir and not os.environ.get("AFFECT_STATE_DIR"):
            project = hashlib.sha256(os.fsencode(Path.cwd())).hexdigest()[:20]
            a.state_dir = Path.home() / ".local" / "state" / "agent-emotion-core" / project
    if not a.agent:
        ap.error("--agent or AFFECT_AGENT is required")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", a.agent) or a.agent.startswith("."):
        ap.error("agent id must be 1-64 characters from A-Z a-z 0-9 _ . - and not start with a dot")
    if a.hours is not None and not (0 <= a.hours < 1e7):
        ap.error("--hours must be zero or positive")
    persona = _read_json(a.persona) if a.persona else None
    d = state_dir(a.state_dir)
    d.mkdir(parents=True, exist_ok=True)
    lock = open(d / f".{a.agent}.lock", "w")
    if fcntl:
        fcntl.flock(lock, fcntl.LOCK_EX)   # serialise concurrent commands for one agent
    if a.cmd == "init" and persona is not None and (d / f"{a.agent}.json").exists():
        sys.exit(f"affect_core: {a.agent} already exists; delete {d / (a.agent + '.json')} to start over")
    try:
        core = load(a.agent, a.state_dir, seed=a.seed, persona=persona)
    except ValueError as e:
        sys.exit(f"affect_core: {e}")
    now = time.time()
    if a.hours is not None:
        core.advance(a.hours)
    else:
        core.advance((now - core.s.get("wall", now)) / 3600.0 * core.cfg["time_scale"])
    core.s["wall"] = now

    if a.cmd == "context":
        print(core.context([x for x in a.with_agents.split(",") if x], brief=a.brief))
    elif native_host or a.cmd in ("finish-turn", "claude-hook"):
        data = _read_json(a.json)
        if not isinstance(data, dict):
            sys.exit("affect_core: expected a turn object")
        try:
            if a.cmd == "finish-turn":
                result = core.finish_turn(data.get("turn_id"), data.get("kind", a.kind),
                                          data.get("thread", a.thread), data.get("appraisals", []))
                print(json.dumps(result))
            else:
                session = data.get("session_id")
                if not isinstance(session, str) or not session or len(session) > 128:
                    raise ValueError("turn hook requires a session_id")
                event = data.get("hook_event_name")
                pending = core.s.setdefault("pending_sessions", {})
                receipt = session
                turn_id = data.get("turn_id") if native_host == "codex" else None
                if turn_id is not None:
                    if not isinstance(turn_id, str) or not turn_id.strip():
                        raise ValueError("invalid Codex turn_id")
                    identity = json.dumps([session, turn_id]).encode()
                    receipt = "codex:" + hashlib.sha256(identity).hexdigest()
                if event == ("BeforeAgent" if native_host == "gemini" else "UserPromptSubmit"):
                    if turn_id is None:
                        pending[receipt] = uuid.uuid4().hex
                    elif receipt not in core.s.get("finished_turns", []):
                        pending[receipt] = receipt
                    people = [x for x in a.with_agents.split(",") if x]
                    context = core.turn_context(data.get("prompt", ""), session, people, brief=a.brief)
                    context += "\nThe completion hook records this chat reply and consolidates it. Appraise meaningful developments once as they occur."
                    if native_host:
                        context += f" Use agent {a.agent} and state directory {d.resolve()} for appraisal commands."
                        output = {"additionalContext": context}
                        if native_host == "codex":
                            output["hookEventName"] = event
                        print(json.dumps({"hookSpecificOutput": output}))
                    else:
                        print(context)
                elif event == ("AfterAgent" if native_host == "gemini" else "Stop"):
                    turn = pending.pop(receipt, None)
                    if turn:
                        key = "prompt_response" if native_host == "gemini" else "last_assistant_message"
                        message = data.get(key) or ""
                        core.finish_turn(turn, "reply" if message else "skip", session,
                                         message=message)
                    if native_host:
                        print("{}")
                else:
                    raise ValueError("unsupported turn hook event")
        except ValueError as e:
            sys.exit(f"affect_core: {e}")
    elif a.cmd == "appraise":
        data = _read_json(a.json)
        data = data if isinstance(data, list) else [data]
        if not all(isinstance(x, dict) and isinstance(x.get("event"), str) and x["event"].strip()
                   for x in data):
            sys.exit('affect_core: appraise expects an object (or array of objects) each with '
                     'a non-empty "event" string')
        try:
            for event in data:
                event_identifier(event)
        except ValueError as e:
            sys.exit(f"affect_core: {e}")
        res = []
        for x in data:
            if x.get("event_id") in core.s.get("seen_event_ids", ()):
                res.append({})
                continue
            out = core.appraise(x)
            res.append(out)
            log(core, a.state_dir, {"type": "appraise", "event": x.get("event"),
                                    "event_id": x.get("event_id"),
                                    "source": x.get("source"), "thread": x.get("thread"),
                                    "elicited": {k: round(v, 3) for k, v in out.items()},
                                    **{k: v for k, v in core.summary().items()
                                       if k in ("t", "mood", "chem", "mood_label")}})
        print(json.dumps(res))
    elif a.cmd == "choose":
        rng = random.Random(a.seed) if a.seed is not None else None
        ths = _read_json(a.json)
        if not isinstance(ths, list):
            sys.exit("affect_core: choose expects a JSON array of thread objects")
        dec = core.choose(ths, rng=rng)
        log(core, a.state_dir, {"type": "choose", "t": round(core.s["t"], 2), **dec})
        print(json.dumps(dec))
    elif a.cmd == "acted":
        core.acted(a.kind, a.thread)
        log(core, a.state_dir, {"type": "acted", "t": round(core.s["t"], 2), "kind": a.kind,
                                "thread": a.thread})
        print(json.dumps({"ok": True, "kind": a.kind, "thread": a.thread}))
    elif a.cmd == "consolidate":
        ch = core.consolidate()
        log(core, a.state_dir, {"type": "consolidate", "t": round(core.s["t"], 2), "changed": ch})
        print(json.dumps(ch))
    elif a.cmd == "state":
        print(json.dumps(core.summary(), indent=1))
    elif a.cmd == "dump":
        print(json.dumps(core.s, indent=1))
    elif a.cmd == "init":
        print(json.dumps(core.s["persona"]))
    save(core, a.state_dir)


if __name__ == "__main__":
    main()
