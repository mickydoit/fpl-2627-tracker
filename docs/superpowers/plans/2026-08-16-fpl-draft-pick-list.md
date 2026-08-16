# FPL Draft Pick List (v02.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live draft board for a 6-manager FPL Draft league that ranks players by value over replacement, reads the draft as it happens, and recommends who to take at each turn.

**Architecture:** One projection engine, two adapters. `js/model.js` is shared with v01 unchanged except for an injectable prior. A Draft adapter derives per-90 stats from season totals and substitutes a `draft_rank`-based prior for the price prior. On top sit four small pure modules — board (replacement level, VORP, tiers), live (ownership state), simulate (survival across the snake gap), advise (the pick recommendation) — and one page that composes them.

**Tech Stack:** Vanilla ES modules, no build step, no framework. Node 20+ for scripts. Tests are plain assertions in `scripts/test.mjs` using the existing `ok()` harness. Static site on GitHub Pages; all network access happens in Node, never the browser.

**Spec:** `docs/superpowers/specs/2026-08-16-fpl-draft-pick-list-design.md`

## Global Constraints

- **No browser network calls.** Neither `fantasy.premierleague.com` nor `draft.premierleague.com` sends CORS headers. All fetching happens in Node and lands as JSON in `data/`. The browser reads same-origin files only.
- **League size is 6**, an input with default 6. Squad quotas are GKP 2, DEF 5, MID 5, FWD 3; 15 players; 11 start.
- **No prices, no budget, no per-club cap, no captain.** Draft sets `captains_disabled: true`.
- **Scoring is identical to the main game** — goals 10/6/5/4, clean sheets 4/4/1/0, defensive contribution 2 at thresholds DEF 10 / MID 12 / FWD 12. `js/model.js` scoring constants need no change.
- **Determinism.** Every simulation takes an explicit seed and defaults to a fixed one. A board that reshuffles on reload is unusable.
- **HTML is generated.** `draft.html` comes from `scripts/build-pages.mjs`. Never hand-edit it.
- **v02 owns the cyan accent** via `data-accent="cyan"`. v01 keeps lime.
- **`npm test` regenerates seed data**, overwriting `data/`. Never commit `data/` changes made by a test run.
- Test names read as sentences and assert one behaviour each. Use the existing `ok(name, cond, detail)` harness in `scripts/test.mjs`.

---

### Task 1: Injectable prior + the Draft adapter

Draft supplies season totals but no per-90 fields, and no `now_cost` at all. The adapter derives the per-90s from `minutes` and replaces the price prior. `js/model.js` currently calls `pricePrior` directly inside `projectFixture`; this task makes it injectable while leaving v01 behaviour bit-identical.

**Files:**
- Modify: `js/model.js` (the `pricePrior` call inside `projectFixture`)
- Create: `js/draft/adapt.js`
- Test: `scripts/test.mjs` (append a new section)

**Interfaces:**
- Consumes: `projectFixture(p, fixture, ctx, opts)` and `DEFAULTS` from `js/model.js`.
- Produces:
  - `draftPrior(p)` → number. Expected points per appearance from `draft_rank`.
  - `adaptDraftElements(draftBoot)` → array of player rows carrying `expected_goals_per_90`, `expected_assists_per_90`, `expected_goals_conceded_per_90`, `saves_per_90`, `defensive_contribution_per_90`, plus every original field.
  - `js/model.js` gains `opts.prior`, a function `(player) => number`, defaulting to the existing `pricePrior`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test.mjs`, before the final summary line:

```js
/* ------------------------------------------------------------------ *
 * Draft adapter
 * ------------------------------------------------------------------ */
console.log('\nDraft adapter');
{
  const el = {
    id: 1, element_type: 3, team: 1, minutes: 1800, status: 'a',
    expected_goals: '10.0', expected_assists: '5.0', expected_goals_conceded: '20.0',
    saves: 0, defensive_contribution: 40, draft_rank: 1, points_per_game: '6.0',
    bps: 600, yellow_cards: 2, web_name: 'Tester',
  };
  const [row] = adaptDraftElements({ elements: [el] });

  ok('xG per 90 derives from totals', near(row.expected_goals_per_90, 0.5, 1e-9),
    `got ${row.expected_goals_per_90}`);
  ok('xA per 90 derives from totals', near(row.expected_assists_per_90, 0.25, 1e-9));
  ok('xGC per 90 derives from totals', near(row.expected_goals_conceded_per_90, 1.0, 1e-9));
  ok('defensive contribution per 90 derives from totals',
    near(row.defensive_contribution_per_90, 2.0, 1e-9));
  ok('original fields survive the adapter', row.web_name === 'Tester' && row.draft_rank === 1);

  const zero = adaptDraftElements({ elements: [{ ...el, minutes: 0 }] })[0];
  ok('a player with no minutes gets no per-90s', zero.expected_goals_per_90 === 0);

  ok('the draft prior is highest at rank 1',
    draftPrior({ element_type: 3, draft_rank: 1 }) > draftPrior({ element_type: 3, draft_rank: 200 }));
  ok('the draft prior stays positive deep down the board',
    draftPrior({ element_type: 3, draft_rank: 500 }) > 0);
  ok('the draft prior needs no price', Number.isFinite(draftPrior({ element_type: 2, draft_rank: 40 })));

  // v01 must be untouched: the default prior is still the price prior.
  const withPrice = { element_type: 3, now_cost: 100, minutes: 0, status: 'a', team: 1 };
  const a = projectFixture(withPrice, { difficulty: 3, home: true }, { games: 38, defence: {} }, {});
  const b = projectFixture(withPrice, { difficulty: 3, home: true }, { games: 38, defence: {} },
    { prior: () => 999 });
  ok('the prior is injectable', b.total > a.total, 'injected prior had no effect');
}
```

Add `projectFixture` to the existing `js/model.js` import list at the top of the file, and add a new import line:

```js
import { adaptDraftElements, draftPrior } from '../js/draft/adapt.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/draft/adapt.js'`

- [ ] **Step 3: Make the prior injectable in `js/model.js`**

Find this line inside `projectFixture`:

```js
  const prior = pricePrior(p) * attMult;
```

Replace it with:

```js
  const prior = (o.prior || pricePrior)(p) * attMult;
```

Then add `prior: null` to the `DEFAULTS` object, with a comment:

```js
  prior: null,          // (player) => pts/appearance; defaults to pricePrior
```

- [ ] **Step 4: Write `js/draft/adapt.js`**

```js
/**
 * Draft -> model adapter.
 *
 * FPL Draft ships season totals but no per-90 fields, and no prices at all.
 * Everything the projection model needs is derivable from `minutes`, except
 * the price prior — which is replaced by one built on the game's own
 * `draft_rank`.
 */

const num = (v) => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Ceiling of the prior per position, matching pricePrior's clamp bounds. */
const PRIOR_CEIL = { 1: 5.2, 2: 6.0, 3: 7.5, 4: 7.5 };
const PRIOR_FLOOR = 0.4;

/**
 * Expected points per appearance from draft rank. Decays from the position
 * ceiling at rank 1 and flattens by roughly rank 200, then takes the higher
 * of that and points_per_game where a player already has a record.
 */
export function draftPrior(p) {
  const rank = num(p.draft_rank) || 500;
  const ceil = PRIOR_CEIL[p.element_type] ?? 6.0;
  const decayed = ceil * Math.exp(-(rank - 1) / 90);
  const ppg = num(p.points_per_game);
  return clamp(Math.max(decayed, ppg), PRIOR_FLOOR, ceil);
}

/** Per-90 rate from a season total. Zero minutes gives zero, not NaN. */
const per90 = (total, minutes) => (minutes > 0 ? (num(total) / minutes) * 90 : 0);

/**
 * Map Draft's bootstrap elements into the row shape js/model.js expects.
 * Original fields are preserved so draft_rank and friends stay available.
 */
export function adaptDraftElements(draftBoot) {
  return (draftBoot?.elements || []).map((p) => {
    const mins = num(p.minutes);
    return {
      ...p,
      expected_goals_per_90: per90(p.expected_goals, mins),
      expected_assists_per_90: per90(p.expected_assists, mins),
      expected_goals_conceded_per_90: per90(p.expected_goals_conceded, mins),
      saves_per_90: per90(p.saves, mins),
      defensive_contribution_per_90: per90(p.defensive_contribution, mins),
    };
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all checks, with the new "Draft adapter" section listed.

- [ ] **Step 6: Restore seed data and commit**

```bash
git checkout data/
git add js/model.js js/draft/adapt.js scripts/test.mjs
git commit -m "feat(draft): adapt Draft data to the shared projection model"
```

---

### Task 2: Snake order, replacement level and VORP

The core of the board. Pure arithmetic, no data fetching.

**Files:**
- Create: `js/draft/board.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `DRAFT_QUOTA` → `{1: 2, 2: 5, 3: 5, 4: 3}`
  - `snakePicks(leagueSize, slot, rounds = 15)` → array of pick numbers
  - `replacementRank(leagueSize, elementType)` → 1-indexed rank of the replacement player
  - `buildBoard(rows, leagueSize)` → `{ rows, replacement }` where each row gains `vorp`, and `replacement` is `{1..4: number}`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test.mjs`:

```js
/* ------------------------------------------------------------------ *
 * Draft board — snake order, replacement level, VORP
 * ------------------------------------------------------------------ */
console.log('\nDraft board');
{
  ok('slot 1 of 6 opens the draft', snakePicks(6, 1)[0] === 1);
  ok('slot 6 of 6 picks back-to-back at the turn',
    snakePicks(6, 6)[0] === 6 && snakePicks(6, 6)[1] === 7);
  ok('slot 1 of 6 waits eleven picks',
    snakePicks(6, 1)[1] - snakePicks(6, 1)[0] === 11);
  ok('a draft runs fifteen rounds', snakePicks(6, 3).length === 15);
  ok('slot 3 of 6 matches the published sequence',
    snakePicks(6, 3).join(',') === '3,10,15,22,27,34,39,46,51,58,63,70,75,82,87');

  // Across all slots, the first two rounds must use every pick exactly once.
  const firstTwo = [];
  for (let s = 1; s <= 6; s++) firstTwo.push(...snakePicks(6, s).slice(0, 2));
  firstTwo.sort((a, b) => a - b);
  ok('every pick in rounds one and two is used exactly once',
    firstTwo.join(',') === Array.from({ length: 12 }, (_, i) => i + 1).join(','));

  ok('six managers draft twelve keepers, so replacement is the 13th',
    replacementRank(6, 1) === 13);
  ok('six managers draft thirty defenders, so replacement is the 31st',
    replacementRank(6, 2) === 31);
  ok('six managers draft eighteen forwards, so replacement is the 19th',
    replacementRank(6, 4) === 19);
  ok('a bigger league pushes replacement deeper', replacementRank(12, 4) > replacementRank(6, 4));

  // Build a synthetic pool: 40 per position, projections descending from 200.
  const pool = [];
  let pid = 1;
  for (const type of [1, 2, 3, 4]) {
    for (let i = 0; i < 40; i++) pool.push({ id: pid++, element_type: type, proj: 200 - i * 3 });
  }
  const { rows, replacement } = buildBoard(pool, 6);
  ok('replacement level is the projection at the replacement rank',
    near(replacement[4], 200 - (19 - 1) * 3, 1e-9), `got ${replacement[4]}`);
  ok('VORP is projection minus replacement', near(
    rows.find((r) => r.element_type === 4).vorp, 200 - replacement[4], 1e-9));
  ok('every row carries a VORP', rows.every((r) => Number.isFinite(r.vorp)));
  ok('the replacement player himself has zero VORP', rows.some((r) => near(r.vorp, 0, 1e-9)));
  ok('players below replacement have negative VORP', rows.some((r) => r.vorp < 0));
}
```

Add the import:

```js
import { snakePicks, replacementRank, buildBoard, DRAFT_QUOTA } from '../js/draft/board.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/draft/board.js'`

- [ ] **Step 3: Write `js/draft/board.js`**

```js
/**
 * Draft board maths: whose turn it is, what a position is worth, and what
 * "worth" means once you account for who you could get instead.
 */

/** Squad quotas — identical to the main game. */
export const DRAFT_QUOTA = { 1: 2, 2: 5, 3: 5, 4: 3 };

/**
 * The pick numbers belonging to one slot in a snake draft.
 * Odd rounds run 1..N, even rounds run N..1.
 */
export function snakePicks(leagueSize, slot, rounds = 15) {
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    out.push(r % 2 === 1 ? (r - 1) * leagueSize + slot : r * leagueSize - slot + 1);
  }
  return out;
}

/**
 * The rank of the first player at a position who will still be unowned once
 * the league has drafted its fill. This is the player you are really choosing
 * against, which is why raw projection is the wrong ranking.
 */
export function replacementRank(leagueSize, elementType) {
  return leagueSize * DRAFT_QUOTA[elementType] + 1;
}

/**
 * Attach VORP to every row and report the replacement level per position.
 * Rows must already carry a `proj` number.
 */
export function buildBoard(rows, leagueSize) {
  const replacement = {};
  for (const type of [1, 2, 3, 4]) {
    const atPos = rows
      .filter((r) => r.element_type === type)
      .sort((a, b) => b.proj - a.proj);
    const idx = replacementRank(leagueSize, type) - 1;
    replacement[type] = atPos[idx]?.proj ?? (atPos[atPos.length - 1]?.proj ?? 0);
  }
  const out = rows
    .map((r) => ({ ...r, vorp: r.proj - replacement[r.element_type] }))
    .sort((a, b) => b.vorp - a.vorp);
  return { rows: out, replacement };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the "Draft board" section listed.

- [ ] **Step 5: Restore seed data and commit**

```bash
git checkout data/
git add js/draft/board.js scripts/test.mjs
git commit -m "feat(draft): snake pick order, replacement level and VORP"
```

---

### Task 3: Tiers

Tiers mark the cliffs in value within a position — the information VORP alone does not carry. They answer "can I wait?" rather than "who is best?".

**Files:**
- Modify: `js/draft/board.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `buildBoard` output rows from Task 2.
- Produces: `assignTiers(rows, sdThreshold = 1.0)` → the same rows, each gaining a 1-indexed `tier` number, numbered independently within each position.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test.mjs`, inside a new block:

```js
console.log('\nDraft tiers');
{
  // Two obvious clusters at one position: 100/99/98, then a cliff, then 50/49/48.
  const rows = [100, 99, 98, 50, 49, 48].map((proj, i) => ({
    id: i + 1, element_type: 3, proj, vorp: proj,
  }));
  const tiered = assignTiers(rows, 1.0);
  const tierOf = (p) => tiered.find((r) => r.proj === p).tier;

  ok('every player lands in a tier', tiered.every((r) => Number.isInteger(r.tier) && r.tier >= 1));
  ok('the top cluster shares a tier', tierOf(100) === tierOf(99) && tierOf(99) === tierOf(98));
  ok('a cliff starts a new tier', tierOf(50) > tierOf(98));
  ok('the second cluster shares a tier', tierOf(50) === tierOf(48));
  ok('tiers start at one', Math.min(...tiered.map((r) => r.tier)) === 1);

  // An evenly spaced position has no cliffs, so it should not fragment.
  const even = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i, element_type: 2, proj: 100 - i, vorp: 100 - i,
  }));
  const evenTiers = assignTiers(even, 1.0);
  ok('an evenly spaced position does not fragment',
    new Set(evenTiers.map((r) => r.tier)).size <= 2,
    `got ${new Set(evenTiers.map((r) => r.tier)).size} tiers`);

  ok('tiers are numbered per position', assignTiers([...rows, ...even], 1.0)
    .filter((r) => r.element_type === 2).some((r) => r.tier === 1));
}
```

Extend the board import to include `assignTiers`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `assignTiers is not a function`

- [ ] **Step 3: Add `assignTiers` to `js/draft/board.js`**

```js
/**
 * Group each position's players into tiers, split where the gap to the next
 * player is unusually large. A tier boundary means "the drop after this one is
 * real" — the cue to take a player now rather than wait a round.
 */
export function assignTiers(rows, sdThreshold = 1.0) {
  const out = [];
  for (const type of [1, 2, 3, 4]) {
    const atPos = rows
      .filter((r) => r.element_type === type)
      .sort((a, b) => b.vorp - a.vorp);
    if (!atPos.length) continue;

    const gaps = [];
    for (let i = 1; i < atPos.length; i++) gaps.push(atPos[i - 1].vorp - atPos[i].vorp);
    const mean = gaps.reduce((s, g) => s + g, 0) / (gaps.length || 1);
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / (gaps.length || 1);
    const sd = Math.sqrt(variance);
    const cut = mean + sdThreshold * sd;

    let tier = 1;
    atPos.forEach((row, i) => {
      if (i > 0 && gaps[i - 1] > cut) tier++;
      out.push({ ...row, tier });
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the "Draft tiers" section listed.

- [ ] **Step 5: Restore seed data and commit**

```bash
git checkout data/
git add js/draft/board.js scripts/test.mjs
git commit -m "feat(draft): tier players by the cliffs in value within a position"
```

---

### Task 4: Live draft state

Turns the league's live draft into a single ownership map, whatever the source. Reading the API and marking players by hand must produce the same shape, so the rest of the code never learns which happened.

**Files:**
- Create: `js/draft/live.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ownershipFrom(elementStatus)` → `Map<elementId, entryId|null>`
  - `availableRows(rows, ownership)` → rows whose id is unowned
  - `deriveSlot(choices, myEntryId, leagueSize)` → 1-indexed slot, or `null` if not yet determinable
  - `myRoster(rows, ownership, myEntryId)` → rows owned by that entry
  - `positionsNeeded(roster)` → `{1..4: number}` remaining against `DRAFT_QUOTA`

- [ ] **Step 1: Write the failing tests**

```js
console.log('\nDraft live state');
{
  const status = [
    { element: 1, owner: null, status: 'a' },
    { element: 2, owner: 55, status: 'o' },
    { element: 3, owner: 77, status: 'o' },
  ];
  const own = ownershipFrom(status);
  ok('ownership maps every element', own.size === 3);
  ok('an unowned player maps to null', own.get(1) === null);
  ok('an owned player maps to his entry', own.get(2) === 55);

  const rows = [1, 2, 3, 4].map((id) => ({ id, element_type: 3, proj: 10, vorp: 1 }));
  const avail = availableRows(rows, own);
  ok('owned players drop out of the pool', avail.map((r) => r.id).join(',') === '1,4');
  ok('a player absent from the map counts as available', avail.some((r) => r.id === 4));

  // Six managers; entry 77 picked third, so slot 3.
  const choices = [
    { pick: 1, entry: 11 }, { pick: 2, entry: 22 }, { pick: 3, entry: 77 },
    { pick: 4, entry: 44 },
  ];
  ok('the slot derives from the first-round pick', deriveSlot(choices, 77, 6) === 3);
  ok('an unknown entry gives no slot', deriveSlot(choices, 999, 6) === null);
  ok('an empty draft gives no slot', deriveSlot([], 77, 6) === null);

  const roster = myRoster(
    [{ id: 2, element_type: 1 }, { id: 3, element_type: 3 }], own, 77);
  ok('the roster holds only my players', roster.length === 1 && roster[0].id === 3);

  const need = positionsNeeded([{ element_type: 1 }, { element_type: 3 }]);
  ok('needs count down from the quota', need[1] === 1 && need[3] === 4);
  ok('an untouched position needs its full quota', need[2] === 5);
  ok('needs never go negative', positionsNeeded(
    Array.from({ length: 9 }, () => ({ element_type: 1 })))[1] === 0);
}
```

Add the import:

```js
import { ownershipFrom, availableRows, deriveSlot, myRoster, positionsNeeded } from '../js/draft/live.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/draft/live.js'`

- [ ] **Step 3: Write `js/draft/live.js`**

```js
/**
 * Live draft state.
 *
 * The board does not care whether picks arrived from the Draft API or were
 * typed in by hand — both reduce to one map of element id to owning entry.
 */
import { DRAFT_QUOTA } from './board.js';

/** Build the ownership map from the API's element_status array. */
export function ownershipFrom(elementStatus) {
  const map = new Map();
  for (const e of elementStatus || []) map.set(e.element, e.owner ?? null);
  return map;
}

/** Rows still on the board. A player missing from the map is available. */
export function availableRows(rows, ownership) {
  return rows.filter((r) => !ownership.get(r.id));
}

/**
 * Which slot is mine? The first round runs 1..N in pick order, so the entry's
 * first-round pick number is its slot. Returns null until that pick lands.
 */
export function deriveSlot(choices, myEntryId, leagueSize) {
  const mine = (choices || [])
    .filter((c) => c.entry === myEntryId && c.pick <= leagueSize)
    .sort((a, b) => a.pick - b.pick)[0];
  return mine ? mine.pick : null;
}

/** The rows I already own. */
export function myRoster(rows, ownership, myEntryId) {
  return rows.filter((r) => ownership.get(r.id) === myEntryId);
}

/** How many of each position I still have to draft. */
export function positionsNeeded(roster) {
  const need = { ...DRAFT_QUOTA };
  for (const p of roster) need[p.element_type] = Math.max(0, need[p.element_type] - 1);
  return need;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the "Draft live state" section listed.

- [ ] **Step 5: Restore seed data and commit**

```bash
git checkout data/
git add js/draft/live.js scripts/test.mjs
git commit -m "feat(draft): model live draft state as one ownership map"
```

---

### Task 5: Survival probability across the snake gap

The only thing worth predicting: will this player still be there at my next turn? Because live state is read exactly, we simulate only the handful of opponent picks between turns — at most five in a 6-manager league.

**Files:**
- Create: `js/draft/simulate.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `availableRows` (Task 4), rows carrying `draft_rank` and `vorp`.
- Produces:
  - `makeRng(seed)` → `() => number` in [0, 1)
  - `picksBetween(currentPick, myPicks)` → number of opponent picks before my next turn, or `Infinity` if I have no further pick
  - `survival(available, opponentPicks, { seed = 12345, trials = 400, greed = 3 })` → `Map<elementId, probability>`

- [ ] **Step 1: Write the failing tests**

```js
console.log('\nDraft survival simulation');
{
  const rng = makeRng(42);
  const first = [rng(), rng(), rng()];
  const again = makeRng(42);
  ok('the rng is deterministic for a seed',
    [again(), again(), again()].join(',') === first.join(','));
  ok('the rng stays in range', first.every((v) => v >= 0 && v < 1));

  const myPicks = [3, 10, 15];
  ok('six opponents pick between my first and second turn', picksBetween(3, myPicks) === 6);
  ok('the count is taken from my current turn', picksBetween(10, myPicks) === 4);
  ok('no further pick means nothing to wait for', picksBetween(15, myPicks) === Infinity);

  // 30 players, draft_rank 1..30. Better ranks should be likelier to go.
  const pool = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, element_type: 3, draft_rank: i + 1, vorp: 100 - i,
  }));
  const s = survival(pool, 6, { seed: 7, trials: 300 });

  ok('every available player gets a probability', s.size === 30);
  ok('probabilities are probabilities',
    [...s.values()].every((v) => v >= 0 && v <= 1));
  ok('the best player is least likely to survive', s.get(1) < s.get(30));
  ok('a deep player almost certainly survives six picks', s.get(30) > 0.9);
  ok('the simulation is deterministic',
    survival(pool, 6, { seed: 7, trials: 300 }).get(1) === s.get(1));
  ok('waiting longer never improves survival',
    survival(pool, 12, { seed: 7, trials: 300 }).get(1) <= s.get(1));
  ok('with no wait, everyone survives',
    survival(pool, 0, { seed: 7, trials: 50 }).get(1) === 1);
}
```

Add the import:

```js
import { makeRng, picksBetween, survival } from '../js/draft/simulate.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/draft/simulate.js'`

- [ ] **Step 3: Write `js/draft/simulate.js`**

```js
/**
 * Survival probability across the snake gap.
 *
 * Because the live board is read exactly, there is no need to simulate a whole
 * draft — only the opponent picks that fall between one of my turns and the
 * next. Opponents are modelled as drafting near the top of the board by the
 * game's own draft_rank, with enough noise to represent real managers being
 * idiosyncratic.
 */

/** Deterministic LCG. Same seed, same board, every time. */
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** How many opponents pick before my next turn. */
export function picksBetween(currentPick, myPicks) {
  const next = myPicks.find((p) => p > currentPick);
  return next === undefined ? Infinity : next - currentPick - 1;
}

/**
 * Probability each available player is still there after `opponentPicks` more
 * selections.
 *
 * The opponent model: sort what is left by draft_rank, then pick from the top
 * `greed` candidates with probability falling off geometrically. `greed` is
 * the width of the window a typical manager chooses within — 1 would make
 * every manager a robot following the rankings exactly.
 */
export function survival(available, opponentPicks, { seed = 12345, trials = 400, greed = 3 } = {}) {
  const out = new Map(available.map((r) => [r.id, 0]));
  if (!Number.isFinite(opponentPicks) || opponentPicks <= 0) {
    for (const r of available) out.set(r.id, 1);
    return out;
  }
  const ranked = [...available].sort(
    (a, b) => (a.draft_rank || 9999) - (b.draft_rank || 9999));
  const rng = makeRng(seed);

  for (let t = 0; t < trials; t++) {
    const gone = new Set();
    for (let k = 0; k < opponentPicks; k++) {
      // Candidates = the top few still on the board.
      const window = [];
      for (const r of ranked) {
        if (gone.has(r.id)) continue;
        window.push(r);
        if (window.length >= greed) break;
      }
      if (!window.length) break;
      // Geometric-ish choice within the window.
      let idx = 0;
      while (idx < window.length - 1 && rng() > 0.55) idx++;
      gone.add(window[idx].id);
    }
    for (const r of available) if (!gone.has(r.id)) out.set(r.id, out.get(r.id) + 1);
  }
  for (const [id, n] of out) out.set(id, n / trials);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the "Draft survival simulation" section listed.

- [ ] **Step 5: Restore seed data and commit**

```bash
git checkout data/
git add js/draft/simulate.js scripts/test.mjs
git commit -m "feat(draft): survival probability across the snake gap"
```

---

### Task 6: The pick recommendation

Combines value and timing into one ranking: take the player who will not come back to you.

**Files:**
- Create: `js/draft/advise.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `survival`, `picksBetween` (Task 5), `positionsNeeded` (Task 4), rows carrying `vorp` and `element_type`.
- Produces: `recommend(available, { myPicks, currentPick, roster, seed, trials })` → rows sorted by `netValue` descending, each gaining `survivalP` and `netValue`.

- [ ] **Step 1: Write the failing tests**

```js
console.log('\nDraft recommendation');
{
  // Two forwards worth 100, one certain to go, one certain to last.
  const pool = [
    { id: 1, element_type: 4, draft_rank: 1, vorp: 100 },
    { id: 2, element_type: 4, draft_rank: 300, vorp: 98 },
    { id: 3, element_type: 3, draft_rank: 2, vorp: 90 },
    { id: 4, element_type: 3, draft_rank: 301, vorp: 88 },
  ];
  const rec = recommend(pool, { myPicks: [3, 10], currentPick: 3, roster: [], trials: 300 });

  ok('every candidate is scored', rec.length === 4);
  ok('candidates carry a survival probability',
    rec.every((r) => r.survivalP >= 0 && r.survivalP <= 1));
  ok('candidates carry a net value', rec.every((r) => Number.isFinite(r.netValue)));
  ok('the list is sorted by net value',
    rec.every((r, i) => i === 0 || rec[i - 1].netValue >= r.netValue));
  ok('a player who will not last outranks an equal one who will',
    rec[0].id === 1, `top was ${rec[0].id}`);

  // A filled position is not recommended again.
  const full = recommend(pool, {
    myPicks: [3, 10], currentPick: 3, trials: 200,
    roster: Array.from({ length: 3 }, () => ({ element_type: 4 })),
  });
  ok('a filled position drops out of the recommendation',
    full.every((r) => r.element_type !== 4));

  // With no later pick, timing is irrelevant and raw VORP wins.
  const last = recommend(pool, { myPicks: [3], currentPick: 3, roster: [], trials: 200 });
  ok('on the final pick the best player wins outright', last[0].id === 1);
  ok('recommendation is deterministic',
    recommend(pool, { myPicks: [3, 10], currentPick: 3, roster: [], trials: 300 })[0].id === rec[0].id);
}
```

Add the import:

```js
import { recommend } from '../js/draft/advise.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/draft/advise.js'`

- [ ] **Step 3: Write `js/draft/advise.js`**

```js
/**
 * The pick recommendation.
 *
 * Ranking by value alone drafts the best player; ranking by value net of what
 * you could still get next turn drafts the player who will not come back. The
 * second is the decision actually in front of you.
 */
import { survival, picksBetween } from './simulate.js';
import { positionsNeeded } from './live.js';

/**
 * Score every available player by VORP net of the opportunity cost of passing.
 *
 * netValue = vorp - E[best vorp at this position still available next turn]
 *
 * A player certain to survive scores near zero: passing costs nothing. A
 * player certain to be gone scores his full VORP over the next man up.
 */
export function recommend(available, {
  myPicks, currentPick, roster = [], seed = 12345, trials = 400,
} = {}) {
  const need = positionsNeeded(roster);
  const eligible = available.filter((r) => (need[r.element_type] ?? 0) > 0);
  const gap = picksBetween(currentPick, myPicks || []);
  const surv = survival(eligible, gap, { seed, trials });

  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const r of eligible) byPos[r.element_type].push(r);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.vorp - a.vorp);

  return eligible
    .map((r) => {
      const p = surv.get(r.id) ?? 0;
      // What I would expect to hold at this position next turn if I pass now:
      // each rival candidate weighted by the chance he is still there.
      const alternatives = byPos[r.element_type].filter((o) => o.id !== r.id);
      let expectedNext = 0;
      let carried = 1;
      for (const alt of alternatives) {
        const ps = surv.get(alt.id) ?? 0;
        expectedNext += carried * ps * alt.vorp;
        carried *= 1 - ps;
        if (carried < 1e-6) break;
      }
      // Passing only costs me when he does not survive.
      const netValue = r.vorp - (p * r.vorp + (1 - p) * expectedNext);
      return { ...r, survivalP: p, netValue };
    })
    .sort((a, b) => b.netValue - a.netValue || b.vorp - a.vorp);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the "Draft recommendation" section listed.

- [ ] **Step 5: Restore seed data and commit**

```bash
git checkout data/
git add js/draft/advise.js scripts/test.mjs
git commit -m "feat(draft): recommend the player who will not come back"
```

---

### Task 7: Beat the baselines

The spec requires proof the board beats naive strategies rather than an assumption that it does. This task simulates whole drafts, six managers, our strategy against two baselines.

**Files:**
- Create: `js/draft/compete.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `recommend` (Task 6), `snakePicks`, `buildBoard` (Task 2), `positionsNeeded` (Task 4).
- Produces: `runDraft(rows, { leagueSize, mySlot, strategy, seed })` → `{ roster, total }` where `total` is the summed `proj` of the best legal XI drafted; `STRATEGIES` → `{ vorp, draftRank, bestAvailable }`.

- [ ] **Step 1: Write the failing tests**

```js
console.log('\nDraft baselines');
{
  // A realistic-ish pool: 60 per position, projections decaying at different
  // rates so positional scarcity actually differs.
  const pool = [];
  let id = 1;
  for (const [type, decay] of [[1, 1.5], [2, 2.0], [3, 2.4], [4, 4.0]]) {
    for (let i = 0; i < 60; i++) {
      pool.push({ id: id++, element_type: type, proj: 200 - i * decay, draft_rank: 0 });
    }
  }
  // draft_rank ordered by raw projection, as the real game's ranking roughly is.
  [...pool].sort((a, b) => b.proj - a.proj).forEach((p, i) => { p.draft_rank = i + 1; });

  const run = (strategy) => runDraft(pool, { leagueSize: 6, mySlot: 3, strategy, seed: 99 });
  const mine = run(STRATEGIES.vorp);
  const byRank = run(STRATEGIES.draftRank);
  const byBest = run(STRATEGIES.bestAvailable);

  ok('a full squad is drafted', mine.roster.length === 15);
  ok('the squad satisfies the position quotas',
    [1, 2, 3, 4].every((t) => mine.roster.filter((r) => r.element_type === t).length
      === { 1: 2, 2: 5, 3: 5, 4: 3 }[t]));
  ok('no player is drafted twice', new Set(mine.roster.map((r) => r.id)).size === 15);
  ok('the VORP board beats drafting by the game ranking',
    mine.total > byRank.total, `${mine.total.toFixed(1)} vs ${byRank.total.toFixed(1)}`);
  ok('the VORP board beats best-available',
    mine.total > byBest.total, `${mine.total.toFixed(1)} vs ${byBest.total.toFixed(1)}`);
  ok('a draft is reproducible',
    runDraft(pool, { leagueSize: 6, mySlot: 3, strategy: STRATEGIES.vorp, seed: 99 }).total
      === mine.total);
}
```

Add the import:

```js
import { runDraft, STRATEGIES } from '../js/draft/compete.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/draft/compete.js'`

- [ ] **Step 3: Write `js/draft/compete.js`**

```js
/**
 * Whole-draft simulation, used only to prove the board is worth having.
 *
 * Every manager but me drafts by draft_rank with a little noise. I draft by
 * whichever strategy is under test. The score is the best legal XI I end up
 * with, since bench players contribute nothing directly in Draft.
 */
import { snakePicks, buildBoard, DRAFT_QUOTA } from './board.js';
import { positionsNeeded } from './live.js';
import { recommend } from './advise.js';
import { makeRng } from './simulate.js';

/** Best legal XI from a 15: 1 GK, at least 3 DEF, 2 MID, 1 FWD, 11 total. */
function bestElevenTotal(roster) {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of roster) byPos[p.element_type].push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.proj - a.proj);

  const min = { 1: 1, 2: 3, 3: 2, 4: 1 };
  const xi = [];
  for (const t of [1, 2, 3, 4]) xi.push(...byPos[t].slice(0, min[t]));
  const rest = [];
  for (const t of [2, 3, 4]) rest.push(...byPos[t].slice(min[t]));
  rest.sort((a, b) => b.proj - a.proj);
  xi.push(...rest.slice(0, 11 - xi.length));
  return xi.reduce((s, p) => s + p.proj, 0);
}

export const STRATEGIES = {
  /** Our board: VORP net of what survives to the next pick. */
  vorp: (pool, ctx) => recommend(pool, {
    myPicks: ctx.myPicks, currentPick: ctx.pick, roster: ctx.roster,
    seed: ctx.seed, trials: 120,
  })[0],
  /** Follow the game's own ranking, respecting quotas. */
  draftRank: (pool, ctx) => {
    const need = positionsNeeded(ctx.roster);
    return pool.filter((p) => need[p.element_type] > 0)
      .sort((a, b) => a.draft_rank - b.draft_rank)[0];
  },
  /** Highest raw projection, respecting quotas. */
  bestAvailable: (pool, ctx) => {
    const need = positionsNeeded(ctx.roster);
    return pool.filter((p) => need[p.element_type] > 0)
      .sort((a, b) => b.proj - a.proj)[0];
  },
};

/** Run one full snake draft and report what my strategy ended up with. */
export function runDraft(rows, { leagueSize = 6, mySlot = 3, strategy, seed = 12345 } = {}) {
  const { rows: board } = buildBoard(rows, leagueSize);
  const byId = new Map(board.map((r) => [r.id, r]));
  const myPicks = new Set(snakePicks(leagueSize, mySlot));
  const myPickList = snakePicks(leagueSize, mySlot);
  const rng = makeRng(seed);

  const taken = new Set();
  const rosters = new Map();
  for (let s = 1; s <= leagueSize; s++) rosters.set(s, []);

  const totalPicks = leagueSize * 15;
  for (let pick = 1; pick <= totalPicks; pick++) {
    const round = Math.ceil(pick / leagueSize);
    const inRound = pick - (round - 1) * leagueSize;
    const slot = round % 2 === 1 ? inRound : leagueSize - inRound + 1;
    const roster = rosters.get(slot);
    const pool = board.filter((r) => !taken.has(r.id));

    let choice;
    if (myPicks.has(pick)) {
      choice = strategy(pool, { myPicks: myPickList, pick, roster, seed });
    } else {
      const need = positionsNeeded(roster);
      const window = pool.filter((p) => need[p.element_type] > 0)
        .sort((a, b) => a.draft_rank - b.draft_rank).slice(0, 3);
      let idx = 0;
      while (idx < window.length - 1 && rng() > 0.55) idx++;
      choice = window[idx];
    }
    if (!choice) continue;
    taken.add(choice.id);
    roster.push(byId.get(choice.id));
  }

  const roster = rosters.get(mySlot);
  return { roster, total: bestElevenTotal(roster) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the "Draft baselines" section listed and both comparison lines showing our total ahead.

If the board does **not** beat both baselines, stop and report it. That is the design failing its own test, not a bug to paper over.

- [ ] **Step 5: Restore seed data and commit**

```bash
git checkout data/
git add js/draft/compete.js scripts/test.mjs
git commit -m "test(draft): prove the board beats rank and best-available"
```

---

### Task 8: Draft data fetch and seed

Brings real Draft data into `data/draft/`, and synthetic data for the test suite so `npm test` still runs without a network.

**Files:**
- Create: `scripts/fetch-draft.mjs`
- Create: `scripts/make-draft-sample.mjs`
- Modify: `package.json` (scripts)
- Modify: `.github/workflows/refresh.yml`

**Interfaces:**
- Consumes: `getJSON` from `scripts/lib/http.mjs`, `writeJSONIfChanged` from `scripts/lib/io.mjs`.
- Produces: `data/draft/bootstrap.json`, `data/draft/league.json`, `data/draft/choices.json`.

- [ ] **Step 1: Write `scripts/fetch-draft.mjs`**

```js
/**
 * Fetch FPL Draft data. Server-side only — the Draft API sends no CORS
 * headers, exactly like the main game's.
 *
 * DRAFT_LEAGUE_ID is optional: without it we still get the player pool, which
 * is all the pre-draft board needs.
 */
import { getJSON } from './lib/http.mjs';
import { writeJSONIfChanged } from './lib/io.mjs';
import { mkdir } from 'node:fs/promises';

const API = 'https://draft.premierleague.com/api';
const LEAGUE = process.env.DRAFT_LEAGUE_ID;
const DIR = 'data/draft';

await mkdir(DIR, { recursive: true });

console.log('→ draft bootstrap-static');
const boot = await getJSON(`${API}/bootstrap-static`, { browserUA: true });
if (!boot?.elements?.length) throw new Error('draft bootstrap returned no players');
await writeJSONIfChanged(`${DIR}/bootstrap.json`, boot);
console.log(`  ${boot.elements.length} players`);

if (LEAGUE) {
  console.log(`→ league ${LEAGUE}`);
  const details = await getJSON(`${API}/league/${LEAGUE}/details`, { browserUA: true })
    .catch((e) => { console.warn(`  league details failed: ${e.message}`); return null; });
  if (details) await writeJSONIfChanged(`${DIR}/league.json`, details);

  const choices = await getJSON(`${API}/draft/${LEAGUE}/choices`, { browserUA: true })
    .catch((e) => { console.warn(`  choices failed: ${e.message}`); return null; });
  if (choices) {
    await writeJSONIfChanged(`${DIR}/choices.json`, choices);
    const owned = (choices.element_status || []).filter((e) => e.owner).length;
    console.log(`  ${choices.choices?.length || 0} picks made, ${owned} players owned`);
  }
} else {
  console.log('  DRAFT_LEAGUE_ID not set — player pool only.');
}

console.log('✓ draft data written');
```

- [ ] **Step 2: Write `scripts/make-draft-sample.mjs`**

```js
/**
 * Synthetic Draft data so the test suite runs with no network. Mirrors the
 * real bootstrap's shape: season totals, no per-90s, no prices, a draft_rank.
 */
import { writeJSON } from './lib/io.mjs';
import { mkdir } from 'node:fs/promises';

const QUOTA_POOL = { 1: 60, 2: 200, 3: 200, 4: 127 };
const rand = (() => { let s = 20260816; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();

const elements = [];
let id = 1;
for (const [type, count] of Object.entries(QUOTA_POOL)) {
  for (let i = 0; i < count; i++) {
    const quality = Math.max(0.05, 1 - i / count);
    const minutes = Math.round(quality * 3200 * (0.6 + rand() * 0.4));
    elements.push({
      id: id++, element_type: +type, team: (id % 20) + 1, status: 'a',
      web_name: `D${type}-${i}`, first_name: 'Draft', second_name: `Player ${id}`,
      minutes,
      expected_goals: (quality * (type === 4 ? 18 : type === 3 ? 10 : 2)).toFixed(2),
      expected_assists: (quality * 8).toFixed(2),
      expected_goals_conceded: (minutes / 90 * (1.0 + rand() * 0.8)).toFixed(2),
      saves: type === 1 ? Math.round(quality * 120) : 0,
      defensive_contribution: type === 1 ? 0 : Math.round(quality * minutes / 90 * 9),
      bps: Math.round(quality * 700), yellow_cards: Math.round(rand() * 6),
      total_points: Math.round(quality * 220), points_per_game: (quality * 6).toFixed(1),
      draft_rank: 0, chance_of_playing_next_round: null, news: '',
    });
  }
}
[...elements].sort((a, b) => b.total_points - a.total_points)
  .forEach((p, i) => { p.draft_rank = i + 1; });

const teams = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1, name: `Team ${i + 1}`, short_name: `T${i + 1}`,
  strength_overall_home: 3, strength_overall_away: 3,
}));

await mkdir('data/draft', { recursive: true });
await writeJSON('data/draft/bootstrap.json', { elements, teams, settings: {} });
console.log(`✓ draft seed written — ${elements.length} players`);
```

- [ ] **Step 3: Wire up the npm scripts**

In `package.json`, add to `"scripts"`:

```json
    "seed:draft": "node scripts/make-draft-sample.mjs",
    "refresh:draft": "node scripts/fetch-draft.mjs",
```

and change `"test"` so the draft seed is generated too:

```json
    "test": "node scripts/make-sample.mjs && node scripts/make-draft-sample.mjs && node scripts/test.mjs",
```

- [ ] **Step 4: Add the draft fetch to the workflow**

In `.github/workflows/refresh.yml`, after the existing fetch step, add:

```yaml
      - name: Fetch Draft data
        run: node scripts/fetch-draft.mjs
        env:
          DRAFT_LEAGUE_ID: ${{ vars.DRAFT_LEAGUE_ID }}
        continue-on-error: true
```

`continue-on-error` matters: a Draft outage must not break the v01 refresh.

- [ ] **Step 5: Verify both paths**

Run: `npm run seed:draft && node -e "const d=require('./data/draft/bootstrap.json');console.log(d.elements.length,'players; ranks 1..',Math.max(...d.elements.map(e=>e.draft_rank)))"`
Expected: 587 players, ranks 1..587.

Run: `npm test`
Expected: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git checkout data/
git add scripts/fetch-draft.mjs scripts/make-draft-sample.mjs package.json .github/workflows/refresh.yml
git commit -m "feat(draft): fetch real Draft data and seed synthetic data for tests"
```

---

### Task 9: The live poller

One command on draft night. Polls the league's picks and writes a file the page reads.

**Files:**
- Create: `scripts/draft-live.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getJSON`, `writeJSONIfChanged`.
- Produces: `data/draft/choices.json`, refreshed every few seconds while the draft is live.

- [ ] **Step 1: Write `scripts/draft-live.mjs`**

```js
/**
 * Live draft poller. Run on draft night:
 *
 *   DRAFT_LEAGUE_ID=12345 npm run draft-live
 *
 * The Draft API sends no CORS headers so the page cannot poll it directly, and
 * the scheduled Action runs every 30 minutes against a 60-second pick clock.
 * This bridges the gap: Node polls, the page reads the file same-origin.
 */
import { getJSON } from './lib/http.mjs';
import { writeJSONIfChanged } from './lib/io.mjs';
import { mkdir } from 'node:fs/promises';

const API = 'https://draft.premierleague.com/api';
const LEAGUE = process.env.DRAFT_LEAGUE_ID || process.argv[2];
const EVERY_MS = 5000;

if (!LEAGUE) {
  console.error('Set DRAFT_LEAGUE_ID (the number in your league URL), e.g.');
  console.error('  DRAFT_LEAGUE_ID=12345 npm run draft-live');
  process.exit(1);
}

await mkdir('data/draft', { recursive: true });
console.log(`Polling league ${LEAGUE} every ${EVERY_MS / 1000}s. Ctrl-C to stop.`);

let lastCount = -1;
for (;;) {
  try {
    const [choices, details] = await Promise.all([
      getJSON(`${API}/draft/${LEAGUE}/choices`, { browserUA: true, retries: 1 }),
      getJSON(`${API}/league/${LEAGUE}/details`, { browserUA: true, retries: 1 }),
    ]);
    if (choices) {
      await writeJSONIfChanged('data/draft/choices.json', choices);
      const n = choices.choices?.length || 0;
      if (n !== lastCount) {
        const last = choices.choices?.[n - 1];
        console.log(`  ${n} picks made${last ? ` — latest: pick ${last.pick}` : ''}`);
        lastCount = n;
      }
    }
    if (details) {
      await writeJSONIfChanged('data/draft/league.json', details);
      const status = details.league?.draft_status;
      if (status && status !== 'live' && status !== 'pre') {
        console.log(`Draft status is "${status}" — stopping.`);
        break;
      }
    }
  } catch (e) {
    console.warn(`  poll failed (will retry): ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`:

```json
    "draft-live": "node scripts/draft-live.mjs",
```

- [ ] **Step 3: Verify it refuses to run without a league id**

Run: `npm run draft-live`
Expected: exits with the usage message and a non-zero code.

- [ ] **Step 4: Verify it polls a real league**

Run: `DRAFT_LEAGUE_ID=1 timeout 12 npm run draft-live || true`
Expected: prints the polling banner and at least one pick count line, without crashing. (League 1 is a public league used purely to confirm the endpoint shape.)

- [ ] **Step 5: Commit**

```bash
git checkout data/
git add scripts/draft-live.mjs package.json
git commit -m "feat(draft): poll the live draft from Node on draft night"
```

---

### Task 10: The draft page

Composes everything into the view used on the night. Three sections on one page sharing state.

**Files:**
- Create: `js/pages/draft.js`
- Modify: `scripts/build-pages.mjs` (add the page entry)
- Modify: `css/app.css` (draft board styles)
- Test: browser verification, plus the existing suite must stay green

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `draft.html`, generated.

- [ ] **Step 1: Add the page to the generator**

In `scripts/build-pages.mjs`, add to the `PAGES` array after the `squad` entry:

```js
  { slug: 'draft',     title: 'Draft Board',       accent: 'cyan',   icon: 'nav-bracket',  nav: 'Draft' },
```

- [ ] **Step 2: Write `js/pages/draft.js`**

```js
/**
 * Draft board — the view used live on draft night.
 *
 * Three sections over one state: the big board, my turn, and the roster.
 * Ownership comes from data/draft/choices.json when the poller is running, and
 * from hand-marking otherwise; the board cannot tell the difference.
 */
import { $, el, fmt, setKids } from '../ui.js';
import { readSnapshot } from '../data.js';
import { projectAll } from '../model.js';
import { adaptDraftElements, draftPrior } from '../draft/adapt.js';
import { buildBoard, assignTiers, snakePicks } from '../draft/board.js';
import { ownershipFrom, availableRows, myRoster, positionsNeeded, deriveSlot } from '../draft/live.js';
import { recommend } from '../draft/advise.js';

const app = $('#app');
const LEAGUE_SIZE = 6;

const boot = await readSnapshot('draft/bootstrap');
const fixtures = await readSnapshot('fixtures', []);
if (!boot?.elements?.length) {
  setKids(app, el('p', { class: 'empty' }, 'No draft data yet — run `npm run refresh:draft`.'));
  throw new Error('no draft data');
}

let choices = await readSnapshot('draft/choices', { choices: [], element_status: [] });
let manual = new Set(JSON.parse(localStorage.getItem('draftTaken') || '[]'));
let myEntry = +(localStorage.getItem('draftEntry') || 0) || null;
let mySlot = null;
let currentPick = 1;

/* Project every player over the whole season, using the draft prior. */
const adapted = adaptDraftElements(boot);
const { rows: projected } = projectAll(
  { ...boot, elements: adapted }, fixtures, { horizon: 38, prior: draftPrior });

function state() {
  const own = ownershipFrom(choices.element_status);
  for (const id of manual) own.set(id, own.get(id) || -1);
  const pool = availableRows(projected, own);
  const { rows, replacement } = buildBoard(projected, LEAGUE_SIZE);
  const tiered = assignTiers(rows);
  const byId = new Map(tiered.map((r) => [r.id, r]));
  const available = pool.map((r) => byId.get(r.id)).filter(Boolean);
  const roster = myEntry ? myRoster(projected, own, myEntry) : [];
  mySlot = deriveSlot(choices.choices, myEntry, LEAGUE_SIZE) || mySlot;
  currentPick = (choices.choices?.length || manual.size) + 1;
  return { own, available, roster, replacement, tiered };
}

function render() {
  const { available, roster, replacement } = state();
  const myPicks = mySlot ? snakePicks(LEAGUE_SIZE, mySlot) : [];
  const advice = recommend(available, {
    myPicks, currentPick, roster, trials: 300,
  }).slice(0, 12);
  const need = positionsNeeded(roster);
  const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

  const take = (p) => {
    manual.add(p.id);
    localStorage.setItem('draftTaken', JSON.stringify([...manual]));
    render();
  };

  setKids(app,
    el('div', { class: 'tiles' },
      el('div', { class: 'tile accent' },
        el('span', { class: 'k' }, 'Pick'), el('span', { class: 'v' }, `#${currentPick}`),
        el('span', { class: 's' }, mySlot ? `you are slot ${mySlot}` : 'slot not set')),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'On the board'), el('span', { class: 'v' }, `${available.length}`),
        el('span', { class: 's' }, `${roster.length}/15 drafted`)),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'Still needed'),
        el('span', { class: 'v' }, [1, 2, 3, 4].filter((t) => need[t]).map((t) => POS[t]).join(' ')),
        el('span', { class: 's' }, [1, 2, 3, 4].map((t) => `${need[t]}${POS[t][0]}`).join(' '))),
    ),
    el('div', { class: 'card' },
      el('h2', {}, mySlot && myPicks.includes(currentPick) ? 'Your pick — take one of these' : 'Best available'),
      el('div', { class: 'tablewrap' },
        el('table', { class: 'players' },
          el('thead', {}, el('tr', {},
            ...['Player', 'Pos', 'Tier', 'Proj', 'VORP', 'Survives', 'Net', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, advice.map((p) => el('tr', {},
            el('td', {}, p.web_name),
            el('td', {}, POS[p.element_type]),
            el('td', { class: 'num' }, `T${p.tier}`),
            el('td', { class: 'num' }, fmt.pts(p.proj)),
            el('td', { class: 'num' }, fmt.pts(p.vorp)),
            el('td', { class: 'num' }, `${Math.round(p.survivalP * 100)}%`),
            el('td', { class: 'num' }, fmt.pts(p.netValue)),
            el('td', {}, el('button', { class: 'ghost', onClick: () => take(p) }, 'Taken')),
          ))))),
      el('p', { class: 'hint' },
        'Survives = chance he is still there at your next pick. Net = what passing costs you.'),
    ),
    el('div', { class: 'card' },
      el('h2', {}, 'Your squad'),
      roster.length
        ? el('ul', { class: 'mover-list' }, roster.map((p) => el('li', {}, `${POS[p.element_type]} ${p.web_name}`)))
        : el('p', { class: 'empty' }, 'Nothing drafted yet.'),
      el('p', { class: 'hint' }, `Replacement level — ${[1, 2, 3, 4]
        .map((t) => `${POS[t]} ${fmt.pts(replacement[t])}`).join(' · ')}`),
    ),
  );
}

/* Re-read the poller's file while the draft runs. */
setInterval(async () => {
  const fresh = await readSnapshot('draft/choices', null);
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(choices)) {
    choices = fresh;
    render();
  }
}, 4000);

render();
```

- [ ] **Step 3: Check `readSnapshot` exists in `js/data.js`**

Run: `grep -n 'export.*readSnapshot\|export function load' js/data.js`

If there is no `readSnapshot`, add one next to `loadAll`:

```js
/** Read one snapshot by name, e.g. 'draft/bootstrap'. */
export async function readSnapshot(name, fallback = null) {
  try {
    const res = await fetch(`data/${name}.json`, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: Regenerate the pages and check the suite**

Run: `node scripts/build-pages.mjs && npm test`
Expected: `draft.html` is created; all checks pass.

- [ ] **Step 5: Verify in a real browser**

Run: `npm run seed:draft && python3 -m http.server 8099`

Then drive it headlessly and confirm: the board renders, a row can be marked Taken, the pool shrinks by one, and no console errors appear. Use the same puppeteer-core approach used for the drag-and-drop work.

Expected: board renders with players; clicking "Taken" removes that player and re-ranks; `pageerror` count is zero.

- [ ] **Step 6: Commit**

```bash
git checkout data/
git add js/pages/draft.js js/data.js scripts/build-pages.mjs css/app.css draft.html
git commit -m "feat(draft): the live draft board page"
```

---

## Done when

- `npm test` passes with all new sections listed, including the baseline comparison showing the VORP board ahead of both `draft_rank` and best-available.
- `npm run refresh:draft` pulls 587 real players into `data/draft/`.
- `DRAFT_LEAGUE_ID=<id> npm run draft-live` prints rising pick counts during a live draft.
- `draft.html` renders the board, marks players taken, and re-ranks, with no console errors.
- v01 is untouched: the squad optimiser, its tests and its output are unchanged.
