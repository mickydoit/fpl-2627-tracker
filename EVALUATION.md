# Evaluation baseline

Frozen 26 August 2026, after GW1 and before GW2. The tracker is now in an
evidence-collection period: no predictive modelling changes until the archive
can answer whether they help.

**One exception, and only one.** The freeze exists to stop the model being
tuned on outcomes it has already seen. It does not cover a quantity that can be
shown wrong *before* a ball is kicked, by arithmetic rather than by a result —
see "Identity checks" below. Such a defect is not a hypothesis awaiting
evidence, and leaving it in place would pollute the very archive the freeze is
protecting. Fixing one is in scope; anything that needs a result to justify it
is not.

## Two modes, never mixed

**ARCHIVED / OUT-OF-SAMPLE** — the projection actually frozen before a deadline,
by whichever model was in production then. This is the only figure that counts
as model performance, because nothing about it could have seen the result.
`npm run evaluate` reports this mode and says so in its own header.

**CURRENT MODEL REPLAY / RETROSPECTIVE** — today's model re-run over the same
frozen inputs. Useful for asking how a later change would have behaved. It is
**not** out-of-sample: every change since GW1 was made with GW1's result known.
A replay that "beats" an archived forecast has merely been developed afterwards.

For GW1 the two are:

| Mode | Projected | Actual |
|---|---:|---:|
| Archived (pre-Phase-1 model, `git:d37ebde`) | 773.41 | 948.00 |
| Current-model replay | 686.79 | 948.00 |

Quoting 686.79 against 773.41 as an improvement or regression would be
meaningless. They are different models scored under different rules.

## Route decomposition is mode-bound

The archive stores a projection **total**, not its components. An archived
forecast's route split is therefore **unavailable for schema ≤ 4**, and must not
be approximated by running today's code over the old inputs — that is a
different model's opinion wearing the archived number's label.

From schema 5, `diagnostics` freezes expected goals, expected assists and the
DefCon threshold probability, and `actual` carries the realised routes. Route
comparison becomes available from **GW2 onward**.

## Bias convention

    bias = actual − projected

Positive means the model projected too low. Reported per player, so `bias × n`
reconciles exactly with the aggregate gap. The calibration ratio
(`actual / projected`) is the same fact multiplicatively — quote one, not both
as if independent.

## Provenance

Every archived gameweek from schema 5 records `modelCommit`, `capturedAt` and
`schema`, so a GW8 model can be compared with a GW9 model without ambiguity
about whether a difference came from the code or the data.

## GW1 baseline — archived, out-of-sample

    n 600   projected 773.4   actual 946.0   ratio 1.223
    MAE 1.48   RMSE 2.60   bias +0.29   rho 0.550
    top10 3.30 / top20 3.80 / top50 4.00 against a field of 1.58

Coverage: 10 of 610 players had no projection — they were added to the game
after the deadline and contributed 2 points. Not underprediction.

Interpretation: **likely variance, with a secondary calibration component**.
The top ten positive residuals account for 68% of the net gap and are almost
all cheap defenders who scored, kept a clean sheet and took bonus in the same
match. Scoring rules verified exactly for all 610 players.

## Identity checks

A gameweek's opportunity model is bounded by the pitch, and the bounds are
exact. For a round of `F` fixtures across `T` teams:

    sum(pStart)   ==  11 x T
    sum(expMins)  ~=  90 x 22 x F

These need no result and no hindsight — they can be checked against a
pre-deadline snapshot the moment it is written. Any breach is a defect, not a
hypothesis.

### GW2 — breach found and fixed, 28 August 2026

The snapshot captured at 01:11 UTC claimed **240.9 starters against a ceiling of
220 (+9.5%)** and **23,101 minutes against 19,800 (+16.7%)**. GW1 had been
calibrated on minutes (19,340 vs 19,652), so this was a regression, not H1.

It was concentrated in the promoted clubs — COV 15.84 expected starters, IPS
15.80, HUL 15.22 against a target of 11 — and had two independent causes:

1. **A foreign season defeated its own discount by volume.**
   `ESPN_TRANSITION.minutesWeight` (0.65) is not a ceiling. An ever-present
   Championship season is ~3,400 minutes, and 0.65 of that is 2,210 — five
   times the 450 at which `js/model.js` trusts role evidence completely. The
   Tier-3 branch in `hydrate` also never set `startProbability`, so the
   appearance fallback inverted those unblended minutes directly: Kitching, who
   has never played a Premier League minute, was projected at 87.9 expected
   minutes and **P(start) = 1.000**. `ESPN_TRANSITION.productionCeiling` already
   existed for exactly this argument on the production side; the role side had
   no equivalent. It does now (`minutesCeiling`).

2. **An inferred start overrode a reported one.** `impliedStarts` promotes any
   appearance longer than the 19.7-minute sub ceiling to a full start. That is
   right for a source that cannot report starts — an older prior file, an
   ESPN-derived row — and wrong for bootstrap, which reports them per player. At
   one game played, a 28-minute cameo became a start, and with no last-season
   term to dilute it `startRateGivenFeatured` became 1/1. Torp and Rudoni, both
   substitutes in GW1, were certainties to start GW2.

Believing the reported count alone then produced the opposite absurdity —
P(start) exactly 0.00 for the same players — so `startRateGivenFeatured` now
shrinks toward the population rate (0.806, measured on GW1: 174 starts / 216
featured) with one game of weight, mirroring the shrinkage `minsPerStart` has
always had. One appearance is weighed evenly against the population and cannot
on its own establish certainty in either direction.

    sum(pStart)   240.8  ->  223.7   (+9.5%  ->  +1.7%)
    sum(expMins) 23,101  ->  21,696  (+16.7% ->  +9.6%)

Ranking is effectively untouched: Spearman rho 0.9963 across 616 players, the
top 20 unchanged, and exactly one player in the top 50 moving more than five
places. This corrected nothing about who to pick; it corrected what the model
claims to know. Eleven regression checks in `scripts/test.mjs` pin both causes —
five of them fail against the pre-fix model.

**The archived series is therefore not one model.** GW1 is `d37ebde`, GW2 onward
carries the fix. `modelCommit` records which, and the two must not be pooled
into a single calibration figure without saying so.

**The residual is real and is being left alone.** Expected minutes are still
+9.6% over the ceiling after both fixes, and that excess is league-wide — 17 of
20 clubs ran over, including Arsenal, City and Liverpool, none of which have the
promoted-club problem. That is H1's actual subject and it stays frozen until
GW5-8.

**What +9.6% is, exactly, and what it is not.** Stated because it looks
comparable to H1's +1.6% and is not:

    gameweek     GW2 2026/27
    model        post-fix, the commit recorded in the snapshot's modelCommit
    population   all players in the pre-deadline snapshot
    metric       sum(expMins) against the PHYSICAL CEILING 90 x 22 x 10 = 19,800
    sign         (predicted - ceiling) / ceiling; positive means OVER-prediction
    mode         identity check, pre-deadline, no outcome involved

H1's +1.6% is a different measurement in every one of those rows: a different
gameweek, the pre-fix model, expected minutes against ACTUAL minutes rather than
a ceiling, and — under this file's own `bias = actual - projected` convention —
a positive value meaning UNDER-prediction. The two numbers are both positive and
point in opposite directions.

A like-for-like figure will exist once GW2 settles: the same post-fix model, the
same population, expected minutes against actual minutes. Until then no
predicted-versus-actual minutes calibration exists for the current model, and
the +9.6% may not be quoted as one.

## Registered hypotheses

Frozen before any further results are seen. Do not adjust the model on any of
these until the stated evaluation window.

### H1 — opportunity probability shape

Total expected minutes are approximately calibrated (19,340 vs 19,652, +1.6%),
but P(start) and P(60+) are too dispersed.

**Mode, and a caveat added 29 August 2026.** That 19,340 is a CURRENT-MODEL
REPLAY figure, not an archived one, and it was not labelled as such when this
hypothesis was written. GW1 is archived at schema 1 and carries no `diagnostics`
block at all, so no expected-minutes figure for GW1 exists out-of-sample. It is
also no longer reproducible: `upcomingByTeam` skips started and finished
fixtures, so the current model cannot be replayed over a settled gameweek.

Treat 19,340 as an undated retrospective measurement of the pre-28-August model.
It must not be compared with the +9.6% figure under "Identity checks" — see the
note there for why the two are not the same kind of number.

Expected signature: low buckets start MORE often than predicted, high buckets
start LESS often, total minutes stay well calibrated. GW1 showed 0.10–0.25
predicted → 0.375 observed, and 0.90+ predicted 0.959 → 0.857 observed.

First serious evaluation: **GW5–8**.

### H2 — cold-start prior level

FPL price ranks zero-evidence players well but its aggregate level may be too
conservative. These are separable properties and only the first was tested
historically.

Expected signature: price keeps beating the position prior on rank and MAE,
while the zero-evidence group repeatedly scores above its aggregate
expectation. GW1: 259 zero-evidence players, expected 96.4, actual 214.0 —
68% of the net gap.

Do not adjust unless it persists across multiple gameweeks.

### H3 — DefCon under-prediction

The Poisson threshold model may systematically underestimate hits.

Expected signature: `actual hits / expected hits > 1` persistently, across
gameweeks and positions. GW1 ratio was 2.56 on points, from 31 actual threshold
hits — a small sample.

Evaluate around **GW5–8**.

### H4 — opponent defence versus FDR

Opponent-defence Model B may outperform the current FDR multiplier.

The disagreement is concentrated: all ten largest divergences are fixtures
against Arsenal (FDR 0.950 against Model B 0.604). Model B spans 2.31× where
FDR spans 1.63×; correlation elsewhere is r = 0.760.

Three clubs (COV, HUL, IPS) derive their defensive figure from
`strength_overall_*` — the same editorial family as FDR — so Model B is not an
independent signal for them, and schema 4 records that provenance per club.

Do not promote on GW1 evidence. First frozen ablation around **GW8**.

## What is deliberately not being changed

P(60+), the price-prior level, DefCon, the FDR attack multiplier and the BPS
model all stay as they are until the windows above. P(start) has been changed
once, on 28 August 2026, and only to stop it exceeding the number of players a
match can field — see "Identity checks". Its SHAPE, which is what H1 is about,
is untouched: the residual +9.6% on expected minutes was deliberately left in
place rather than tuned away. Four low-frequency
scoring routes remain unmodelled — penalty saves, red cards, own goals and
penalty misses — which biases projections slightly high; documented, not fixed.

Unknown-return injuries still project zero across every horizon. That is a
known conservative bias, not an unbiased expectation, and it waits on the
availability archive.
