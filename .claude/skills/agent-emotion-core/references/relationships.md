# Relationship-specific appraisal input and research

## Input contract

`appraise()` accepts an optional `relationship` object when the event has a
specific interpersonal meaning:

```json
{"type":"romantic", "affection":0.8, "trust_violation":0.4}
```

The caller must explicitly mark the relationship `romantic`. The engine never
infers romance from warmth, praise, gratitude, closeness, or ordinary positive
interaction. `affection` is a signed appraisal from -1 to 1; `trust_violation`
is an explicit 0-to-1 appraisal. Both update slow person-specific context,
which decays with the liking half-life. Romance context appears only when that
person is explicitly included in `context(with_agents=...)`; an unscoped
context call does not revive a former or absent partner. Repeated strong
positive affection appraisals may be described as loving/attached. This is a
heuristic label, not an attachment-style diagnosis or validated measure.

Inspiration is represented as the co-activation of admiration and interest.
Both retain the event source separately; the blend is reported only when both
states arise from the same named source. This avoids changing the ordinary
attention behavior of interest. This models an
admired person's example capturing attention, rather than treating generic
positive mood as inspiration.

These input fields, blend weights, thresholds, and decay rates are engineering
choices, not validated clinical measures or claims about an agent's subjective
experience.

## Primary research

- [Durbin, Debrot, Karremans, & van der Wal (2021), “Can we use smart-phones to
  increase physical affection, intimacy and security in couples?”](https://doi.org/10.1177/0265407520970278).
  A 39-couple, two-week ecological intervention prompted physical affection.
  The intervention increased momentary intimacy; it did not produce a general
  increase in security, and attachment functioning moderated security effects.
  This supports keeping affection and security/guardedness conceptually
  separate and person-specific.
- [Thrash & Elliot (2003), “Inspiration as a psychological construct”](https://doi.org/10.1037/0022-3514.84.4.871).
  Four studies developed and validated inspiration as a construct characterized
  by evocation, motivation, and transcendence, including daily state
  inspiration. It supports representing inspiration as its own mixed state,
  while the implementation's admiration-plus-interest recipe is a simplifying
  design decision.
- [Thrash et al. (2017), “Writer–reader contagion of inspiration and related
  states”](https://doi.org/10.1037/pspp0000094). In a crossed writer-reader
  study, inspiration in student writers predicted inspiration in readers;
  effects were mediated by text insightfulness and moderated by reader openness.
  This shows interpersonal transmission of inspiration, although the study
  examines poetry rather than romantic or close relationships.
- [Li et al. (2026), “Understanding Grudges: The Interplay Between Hurt Feelings
  and Anger”](https://doi.org/10.1177/01461672251414770). Three observational
  studies and one experiment found stronger grudge reports when hurt and anger
  co-occurred, with perceived transgressor immorality explaining the interaction.
  This supports treating guardedness after an explicit trust violation as a
  relationship-specific response, not as a synonym for general dislike.
- [van Monsjou et al. (2022), “The development and psychometric properties of
  the grudge aspect measure”](https://doi.org/10.1111/pere.12434). Three studies
  validated grudge dimensions including disdain, emotional persistence, and
  perceived longevity, associated with unforgiveness, revenge, avoidance, and
  rumination. It supports persistent interpersonal context, but the present
  guardedness variable is not intended to be a grudge measure.
