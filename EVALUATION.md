# Evaluation baseline

Frozen 26 August 2026, after GW1 and before GW2. The tracker is now in an
evidence-collection period: no predictive modelling changes until the archive
can answer whether they help.

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

## Registered hypotheses

Frozen before any further results are seen. Do not adjust the model on any of
these until the stated evaluation window.

### H1 — opportunity probability shape

Total expected minutes are approximately calibrated (19,340 vs 19,652, +1.6%),
but P(start) and P(60+) are too dispersed.

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

P(start), P(60+), the price-prior level, DefCon, the FDR attack multiplier and
the BPS model all stay as they are until the windows above. Four low-frequency
scoring routes remain unmodelled — penalty saves, red cards, own goals and
penalty misses — which biases projections slightly high; documented, not fixed.

Unknown-return injuries still project zero across every horizon. That is a
known conservative bias, not an unbiased expectation, and it waits on the
availability archive.
