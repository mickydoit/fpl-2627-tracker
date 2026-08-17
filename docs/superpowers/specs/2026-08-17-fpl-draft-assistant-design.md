# FPL Draft Assistant — Phase 1 Design

**Date:** 17 August 2026
**Status:** approved, ready for implementation planning
**Scope:** Phase 1 only — the live draft assistant. Phase 2 (season waiver engine) is specified separately.

---

## Goal

During a live FPL Draft, the deployed web app continuously answers one question:

> Who is the best player for me to draft right now?

The answer updates after every pick, entered by hand, with no network request and no local process.

---

## Hard constraints

1. **The product is a GitHub Pages web app.** Opening `https://mickydoit.github.io/fpl-2627-tracker/` in a browser is the entire user experience — on draft night and during the season. No localhost, no Terminal, no manual Node, no local poller, no repo access, no hand-generated JSON.
2. **Data reaches the browser only via the existing pipeline:** official APIs → GitHub Action → `data/*.json` → Pages → browser. Node running inside Actions is fine; Node running on the user's machine is not part of the product.
3. **Manual entry is the authoritative live draft state.** Every recalculation after a pick happens in-browser against an already-downloaded dataset. No API request per pick.
4. **The Draft API is not a hard dependency.** The board must be constructible from the normalised dataset alone, and must work when the Draft endpoint is down, changed, or never configured. No league ID is required anywhere in Phase 1.
5. **Classic FPL and Draft player IDs must never be joined on `id`.** Verified: 21 of 587 collide. `code` is a verified 1:1 join (587/587, zero name mismatches).
6. **Classic optimiser rules must not leak into the draft engine.** No budget, no 3-per-club limit, no captaincy, no price-derived ranking.

---

## Audit findings this design responds to

| Finding | Evidence | Consequence |
|---|---|---|
| League-ID path fed the wrong league | `data/draft/league.json` is public "League 5", 4 entries — not the user's league | `LEAGUE_SIZE` was 4, silently corrupting replacement level, snake order and survival |
| Classic/Draft IDs diverge | id 554 = Tzolis (draft) vs Van Oevelen (classic); 21 mismatches | Must join on `code` |
| Replacement level is frozen | `js/pages/draft.js:57` calls `buildBoard(projected, …)` over all players, then filters | VORP never responds to the draft progressing — the biggest correctness gap |
| No draft log | State is a flat `Set` in `localStorage` under `draftTaken` | Opponent rosters, undo, log and correction are all impossible |
| Scoring constants hardcoded | `js/model.js:13–19` | Draft API publishes authoritative config nobody reads |
| Bonus fitted on stale aggregate BPS | `js/model.js:229–230` | Known mis-rating of defenders and keepers under 2026/27 BPS |
| 2025/26 evidence is about to vanish | Bootstrap holds 3420-minute totals; FPL zeroes at GW1 deadline, 21 Aug 17:30Z | The model's entire evidence base disappears mid-season without a frozen prior |

---

## Architecture

### 1. Data layer

**`data/draft/prior-2526.json` — the frozen prior.** Built early, before the 21 Aug wipe, and never overwritten by the refresh workflow. Keyed by player `code`. Contains, per player: identity (`code`, names, position, team), minutes, starts, total points, points per game, goals, assists, clean sheets, goals conceded, saves, penalties saved/missed, own goals, yellow/red cards, xG, xA, xGI, xGC, BPS, bonus, and the defensive-contribution inputs (clearances/blocks/interceptions, tackles, recoveries, `defensive_contribution`).

Raw upstream payloads are also retained under `data/draft/raw/` as an auditable capture, so the normalisation can be re-derived if a field turns out to be needed later.

The projection model reads evidence from this frozen prior blended with live-season data, and must never assume mutable bootstrap fields still hold last season's totals.

**`data/draft/config.json`** — the Draft API's own `settings.scoring` and `settings.squad`, committed by the workflow. Scoring stops being hardcoded. Confirms and supplies: goals 10/6/5/4, assists 3, clean sheets 4/4/1/0, conceded −1 per 2, saves 1 per 3, DefCon 2pts at 10 (DEF) / 12 (MID, FWD) capped at 2 per match, `captains_disabled: true`, squad 2/5/5/3, `default_entries: 8`, entries range 2–16. Absent keys for budget and club limit are themselves the confirmation that neither applies.

**`data/draft/players.json`** — the normalised board dataset: Draft elements joined to classic per-90s and metadata on `code`, carrying `draft_rank` where available. This is the file the page loads. It must be sufficient on its own to render the board.

**How this satisfies "the Draft API is not a hard dependency."** The browser depends on the *committed* `players.json`, never on live Draft API access. If the Draft endpoint is down, changed, or returns nothing at refresh time, the workflow leaves the last good file in place and the app is unaffected. Draft-specific fields (`draft_rank`, Draft element ids, Draft settings) are treated as enrichments: the build must succeed, and the board must rank, using classic data plus the frozen prior alone. Where `draft_rank` is missing, the survival model falls back to ranking opponents' likely picks by projected points instead. `config.json` ships with a checked-in default matching the verified 2026/27 values, so a failed config fetch degrades to correct constants rather than to nothing.

**`scripts/fetch-draft.mjs`** — loses the league requirement entirely; writes the three files above. Runs in Actions on the existing cadence.

**`scripts/draft-live.mjs`** — the local poller, retained but **quarantined as dev/experimental**. It must have zero dependency from the production Draft page, the production workflow, the README's user-facing instructions, or any test required for deployment. The Pages app must remain completely usable without it ever running. It is clearly labelled experimental in-file, and its npm script is marked as such.

### 2. `js/draft/scoring.js` — 2026/27 scoring and BPS estimation

Scoring constants are read from `config.json`, not hardcoded.

BPS is reconstructed from published season components under the 2026/27 table: CBI at 1 per 3 (was 1 per 2), the tackled-penalty event removed, and the restructured keeper save tiers. Available inputs are minutes, starts, goals, assists, clean sheets, saves, CBI, tackles, recoveries, cards, own goals, penalties.

**What this can and cannot claim.** Expected bonus depends on a player's BPS *relative to the other twenty-one players in that specific match*. Match-level Opta event data is not public, so exact expected bonus is unreconstructable. This module therefore produces an estimated BPS/90, maps it to expected bonus, flags the result `approximate: true`, and surfaces that caveat in the UI.

**Protection by shrinkage, not by ceiling.** Reconstructed 2026/27 BPS is treated as *lower-confidence evidence* rather than truth, and the bonus estimate is shrunk toward a position-and-minutes baseline in proportion to that uncertainty. A hard cap is explicitly rejected: it would flatten genuinely strong bonus earners — exactly the attacking full-backs and shot-stopping keepers the 2026/27 rebalance is supposed to reward — which is the error the rework exists to fix. Confidence rises where the underlying components are well evidenced (high minutes, consistent starts) and falls where they are thin, so shrinkage does the work a ceiling would have done, without truncating the top of the distribution.

Sanity checks accompany it: the bonus component's share of total projection is asserted to stay within a plausible band per position, and any player whose projection is bonus-dominated is surfaced in the §21 diagnostics for inspection rather than silently ranked.

### 3. `js/model.js` — one surgical change

The bonus component becomes injectable, exactly as `prior` already is (`DEFAULTS.prior`). The draft engine passes the new BPS-based estimator; the classic pages pass nothing and keep their current behaviour unchanged. No other change to the projection engine. The classic squad optimiser is not touched.

### 4. `js/draft/config.js` — tuneable strategy

Every coefficient named, documented and in one place. No magic numbers in the logic.

- `nearTermHorizon` (5 gameweeks, matching the existing default — referenced, never inlined)
- `rosWeight`, `nearTermWeight`, and the draft-stage schedule that shifts weight from ROS toward near-term as rounds progress
- `vorpWeight`, `scarcityWeight`, `urgencyWeight`, `rosterNeedWeight`, `riskWeight`
- `tierGapThreshold` (standard deviations defining a cliff)
- `survivalTrials`, `survivalSeed`, `opponentGreed`
- `minimumImprovement` (reserved for Phase 2 waiver thresholds)

### 5. `js/draft/value.js` — the decision score

Seven named quantities, each computed and exposed **separately** for diagnostics and UI explanation. No single opaque number.

| Quantity | Meaning |
|---|---|
| `projectedPoints` | Expected FPL scoring ability |
| `rosValue` | Expected remaining-season value |
| `vorp` | Value above position-specific replacement |
| `scarcity` | How fast useful supply is disappearing relative to league demand |
| `survival` | Probability this player survives until my next pick |
| `rosterNeed` | How my current composition changes this position's value |
| `risk` | Minutes / injury / rotation / uncertainty penalty |
| `draftValue` | The final decision score derived from the above |

Each candidate also returns a structured `reasons` array generated from these same numbers, so explanations cannot drift from the ranking that produced them.

**Live replacement level.** Recomputed after every pick from the *remaining* pool, and defined by outstanding league-wide demand rather than by the worst player in the database. For an 8-manager league there are 24 forward slots in total; if 16 forwards are gone and 8 slots remain outstanding across all squads, replacement is the player at the edge of that remaining demand. This is what makes VORP meaningful mid-draft.

**Scarcity means cliffs, not counts.** `92, 89, 87, 69, 67` is a scarce position with three players before a real drop; `88, 87, 86, 85, 84` is not, despite similar counts. Scarcity is derived from the existing gap-based tier system, and reports *how many players remain before the next major drop* — the number that actually matters.

**The next-pick model is central.** For each candidate, compare taking him now against an approximation of waiting and taking the expected surviving alternative at that position. This is where `simulate.js` earns its place: a candidate with a 21% chance of a comparable player surviving twelve picks should outrank a similar-projection player at a position where six comparable options will still be there.

### 6. `js/draft/state.js` — versioned, log-driven

The **pick log is the single source of truth.** Everything else derives, which is what keeps state from corrupting.

Persisted (`draftState.v1` in `localStorage`): schema version, setup (league size, my slot), the ordered pick log, any manual corrections, completion state.

Derived, never persisted: taken players, manager rosters, round, current pick, remaining positional demand, my roster, scarcity, replacement levels, rankings.

Each log entry is `{overall, round, managerSlot, elementId, mine}`. Manager attribution comes from snake order. **The log is editable** — a wrong player or wrong manager on an earlier pick can be corrected, and all downstream demand, scarcity, replacement and recommendations recompute from the corrected log. A missed or mis-entered pick must never break the app.

Old `draftTaken` / `draftEntry` keys are migrated where meaningful and otherwise discarded, so stale league-ID-era state cannot corrupt the new mode.

A refresh restores state immediately from browser storage, without waiting on GitHub or any API.

### 7. `js/draft/scarcity.js`

Per position: tiered supply, outstanding league-wide demand inferred from all rosters, supply:demand ratio, players remaining before the next cliff, and a derived urgency label (HIGH / MEDIUM / LOW) — the label comes from the data, never from a hand-written list.

**Hard roster constraints (§12).** When remaining picks equal the number of mandatory unfilled slots, position stops being a weighted term and becomes a filter. With two picks left and one GK and one DEF still required, only GK and DEF are recommendable. The recommender must never be able to leave an illegal roster.

### 8. `js/pages/draft.js` — the interface

Setup asks only for **league size** (default 8, editable, range 2–16) and **my draft slot**, with optional resume from an overall pick number. No league ID.

Sections: **A. Your next pick** (dominant card — player, position, club, draft value, ROS, next-5, VORP, tier, availability warning, and a plain-language *why this pick now*, plus 3–5 alternatives) · **B. Best available** (Overall/GK/DEF/MID/FWD, ranked by draft value, component scores visible) · **C. My squad** (GK 0/2, DEF 0/5, MID 0/5, FWD 0/3, total 0/15) · **D. Positional scarcity** · **E. Pick status** (round, overall pick, my slot, picks until my next turn, who is on the clock) · **F. Draft log** (editable).

**Entry speed is a first-class requirement.** Search a surname → select → `Taken` or `Mine` → continue. Search takes focus, Enter selects, the drafted player disappears immediately, Undo is always visible. No modal is needed for basic entry.

**Responsive.** Desktop is richest. On smaller screens the priority order is: next recommendation, search + Taken/Mine, roster requirements, picks until next selection, best available. Secondary diagnostics collapse below those.

### 9. `scripts/draft-diagnostics.mjs`

Top 20 overall, top 10 GK, top 20 DEF, top 20 MID, top 15 FWD — each showing ROS xPts, draft value, VORP, scarcity, risk and tier. Includes a rank correlation against FPL's official `draft_rank` as a **benchmark, not a target**. If ordinary keepers dominate round one, the formula is wrong and gets investigated rather than accepted.

---

## Testing

TDD throughout, extending the existing suite (149 checks currently passing).

**Rules:** 2/5/5/3 quotas; no budget applied; no 3-per-club constraint; no captain weighting; price never influences draft ranking.

**State:** Mine and Taken both remove from the pool; undo restores exactly; log edits recompute downstream state; localStorage round-trips; snake order and picks-until-next-turn compute correctly at both turn ends.

**Strategy:** filled positions drop out; hard constraints activate late; scarce positions gain urgency; deep positions can be safely deferred; VORP responds to league size; replacement level moves as players are drafted; recommendation changes after a high-value player goes.

**Regression:** the classic squad optimiser, its tests and its output are unchanged.

---

## Draft Night MVP milestone

Because the draft falls before 21 August, Phase 1 is sequenced around an explicit **Draft Night MVP**: a genuinely usable, deployed assistant takes priority over completing every model sophistication.

The MVP must include: GitHub Pages deployment · league size and my draft slot · the current player pool · `Taken` / `Drafted by me` · snake-order attribution · an editable draft log · undo · versioned localStorage persistence · 2/5/5/3 roster tracking · picks until my next turn · dynamic replacement level and VORP · positional supply, demand and scarcity · hard late-draft roster constraints · a best recommendation with alternatives · and a human-readable explanation of why that player and position should be taken now.

Advanced BPS calibration, survival-model tuning and coefficient refinement continue *after* the milestone and must not change the architecture. The plan is structured so that reaching the MVP leaves a deployable, usable app even if every later tuning task remains unfinished.

## Definition of done

Phase 1 is complete only when verified **on the deployed GitHub Pages URL**, not locally:

1. Deploy through the real Pages workflow and verify the deployed Draft URL
2. Start a fresh draft; set league size and slot
3. Enter ~20 simulated picks, several from one position to create scarcity
4. Verify the recommendation changes in response
5. Draft players to my team; confirm roster quotas
6. Undo selections; edit an earlier incorrect pick and confirm downstream recompute
7. Refresh the deployed page; confirm all state survives
8. Drive a draft to its end and confirm hard positional constraints activate
9. Verify a legal final 15 (2 GK / 5 DEF / 5 MID / 3 FWD)
10. Check desktop, tablet and phone widths
11. Confirm non-Draft pages and their tests still work

---

## Phase 2 foundation

Phase 1 must leave behind the state Phase 2 needs, so nothing is thrown away at `Finish Draft`: my 15, every captured opponent roster, every drafted player, every undrafted player, and the resulting initial free-agent pool. Phase 2 (season waiver and free-agent engine, plus optional post-draft league sync — viable because the 30-minute Action cadence is ample for daily waiver timescales) is designed against that state, separately.
