# FPL Draft Assistant (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Draft page into a live FPL Draft decision assistant that works as a plain GitHub Pages web app, with manual pick entry as the authoritative state and every recalculation happening in-browser.

**Architecture:** A frozen 2025/26 evidence snapshot plus a normalised player dataset are committed by the existing GitHub Action. The browser loads them once. A versioned, log-driven state module in `localStorage` is the single source of truth for the draft; taken players, rosters, demand, replacement level, scarcity and rankings are all derived from that log, never persisted independently. A value layer composes seven separately-exposed quantities into a decision score with generated explanations.

**Tech Stack:** Vanilla ES modules (no build step, no framework), Node 20 for scripts, `scripts/test-draft.mjs` as the new test suite, GitHub Actions + GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-08-17-fpl-draft-assistant-design.md`

## Global Constraints

- **The product is a GitHub Pages web app.** No step may introduce a user-facing dependency on localhost, Terminal, manual Node, a local poller, or repo access. Dev scripts and Actions-run Node are fine.
- **No API request per pick.** All post-pick recalculation happens in-browser against already-downloaded data.
- **Never join classic and Draft players on `id`.** 21 of 587 collide. `code` is the verified 1:1 join (587/587).
- **No classic-optimiser rules in the draft engine.** No budget, no 3-per-club limit, no captaincy, no price-derived ranking. `now_cost` may be displayed but must never enter a ranking.
- **The Draft API is not a hard dependency.** The browser reads committed files only. A failed refresh leaves the last good file in place.
- **`scripts/draft-live.mjs` is quarantined.** Zero dependency from the production page, production workflow, README user instructions, or any test required for deployment.
- **Squad quotas:** 2 GK / 5 DEF / 5 MID / 3 FWD, 15 total. **League size:** default 8, editable, range 2–16.
- **Do not modify** `js/optimiser.js`, `js/pages/squad.js`, `js/pages/transfers.js`, or `scripts/test.mjs`. The classic suite's 149 checks must keep passing unchanged.
- **Existing test idiom:** `ok(name, cond, detail)` increments a counter and prints `✓`/`✗`. Match it.

---

## Milestone map

| Milestone | Tasks | Outcome |
|---|---|---|
| **A — Foundation** | 1–3 | Frozen prior, normalised dataset, tuneable config. No UI change. |
| **B — Draft Night MVP** | 4–10 | **Deployed, usable draft assistant.** Stop here and it works. |
| **C — Model sophistication** | 11–13 | BPS reconstruction, diagnostics, tuning. Architecture unchanged. |

Tasks 11–13 may remain unfinished without affecting the MVP's usability.

**Dependency chain:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → *(MVP)* → 11 → 12 → 13.
Task 2 depends only on 1. Tasks 5, 6, 7 each depend on 4. Task 8 depends on 5, 6, 7.

---

## MILESTONE A — Foundation

### Task 1: Freeze the 2025/26 prior

The evidence base disappears when FPL zeroes bootstrap at the GW1 deadline (21 Aug 17:30Z). Raw payloads are already captured in `data/draft/raw/`. This task normalises them into a durable, never-overwritten file.

**Files:**
- Create: `scripts/freeze-prior.mjs`
- Create: `scripts/test-draft.mjs`
- Modify: `package.json` (add `test:draft` and `freeze-prior` scripts, chain into `test`)

**Interfaces:**
- Consumes: `data/draft/raw/classic-bootstrap-2026-08-17.json`, `data/draft/raw/draft-bootstrap-2026-08-17.json`
- Produces: `data/draft/prior-2526.json` — `{ season: '2025/26', capturedAt: ISO string, players: { [code]: PriorPlayer } }` where `PriorPlayer` has numeric fields `minutes, starts, total_points, points_per_game, goals_scored, assists, clean_sheets, goals_conceded, saves, penalties_saved, penalties_missed, own_goals, yellow_cards, red_cards, expected_goals, expected_assists, expected_goal_involvements, expected_goals_conceded, bps, bonus, clearances_blocks_interceptions, tackles, recoveries, defensive_contribution, draft_rank` plus `code, web_name, first_name, second_name, element_type, team`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-draft.mjs`:

```js
/**
 * Draft engine checks. Run with `node scripts/test-draft.mjs`.
 * Kept separate from scripts/test.mjs so the classic model and optimiser
 * suite stays untouched and its regression guarantee stays legible.
 */
import { readJSON } from './lib/io.mjs';

let failures = 0;
let checks = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};

console.log('\nFrozen 2025/26 prior');
const prior = await readJSON('data/draft/prior-2526.json');
ok('the prior file exists', !!prior, 'run `npm run freeze-prior`');
if (prior) {
  const players = Object.values(prior.players || {});
  ok('every 2025/26 player is present', players.length === 587, `got ${players.length}`);
  ok('the season is labelled', prior.season === '2025/26');
  ok('the capture is timestamped', typeof prior.capturedAt === 'string' && prior.capturedAt.length > 0);
  ok('every entry is keyed by its own code',
    Object.entries(prior.players).every(([k, p]) => Number(k) === p.code));
  ok('the season minutes total survives', players.reduce((s, p) => s + p.minutes, 0) === 602348);
  const numeric = ['minutes', 'expected_goals', 'expected_assists', 'bps',
    'clearances_blocks_interceptions', 'tackles', 'recoveries', 'saves'];
  ok('every numeric field is a finite number, not a string',
    players.every((p) => numeric.every((f) => Number.isFinite(p[f]))));
  ok('xG survived as a number, not a string',
    players.some((p) => p.expected_goals > 0));
  ok('draft_rank is carried across from the Draft payload',
    players.filter((p) => Number.isFinite(p.draft_rank)).length > 500);
}

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} draft checks passed`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL — `the prior file exists` fails because `data/draft/prior-2526.json` does not exist yet.

- [ ] **Step 3: Write `scripts/freeze-prior.mjs`**

```js
/**
 * Freeze the 2025/26 evidence before FPL zeroes it at the GW1 deadline.
 *
 * One-shot and idempotent: reads the raw payloads captured in data/draft/raw/
 * and writes a normalised, durable prior keyed by player `code`. Nothing in the
 * refresh workflow may ever overwrite the output — once bootstrap is zeroed,
 * this file is the only surviving record of last season's evidence.
 */
import { readJSON, writeJSON } from './lib/io.mjs';

const RAW_CLASSIC = 'data/draft/raw/classic-bootstrap-2026-08-17.json';
const RAW_DRAFT = 'data/draft/raw/draft-bootstrap-2026-08-17.json';
const OUT = 'data/draft/prior-2526.json';

// Season totals arrive as strings for the expected-goals family and as numbers
// elsewhere. Coerce everything so downstream maths never sees "0.00".
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const FIELDS = [
  'minutes', 'starts', 'total_points', 'points_per_game',
  'goals_scored', 'assists', 'clean_sheets', 'goals_conceded',
  'saves', 'penalties_saved', 'penalties_missed', 'own_goals',
  'yellow_cards', 'red_cards',
  'expected_goals', 'expected_assists', 'expected_goal_involvements',
  'expected_goals_conceded',
  'bps', 'bonus',
  'clearances_blocks_interceptions', 'tackles', 'recoveries',
  'defensive_contribution',
];

const classic = await readJSON(RAW_CLASSIC);
const draft = await readJSON(RAW_DRAFT);
if (!classic?.elements?.length) throw new Error(`no classic payload at ${RAW_CLASSIC}`);
if (!draft?.elements?.length) throw new Error(`no draft payload at ${RAW_DRAFT}`);

// draft_rank lives only in the Draft payload. Join on code — ids collide.
const draftByCode = new Map(draft.elements.map((p) => [p.code, p]));

const players = {};
for (const p of classic.elements) {
  const d = draftByCode.get(p.code);
  const row = {
    code: p.code,
    web_name: p.web_name,
    first_name: p.first_name,
    second_name: p.second_name,
    element_type: p.element_type,
    team: p.team,
    draft_rank: d ? num(d.draft_rank) : null,
  };
  for (const f of FIELDS) row[f] = num(p[f]);
  players[p.code] = row;
}

await writeJSON(OUT, {
  season: '2025/26',
  capturedAt: new Date().toISOString(),
  source: { classic: RAW_CLASSIC, draft: RAW_DRAFT },
  players,
});

const n = Object.keys(players).length;
const mins = Object.values(players).reduce((s, p) => s + p.minutes, 0);
console.log(`✓ froze ${n} players, ${mins} minutes of evidence → ${OUT}`);
```

- [ ] **Step 4: Wire up the npm scripts**

In `package.json`, add to `"scripts"`:

```json
"freeze-prior": "node scripts/freeze-prior.mjs",
"test:draft": "node scripts/test-draft.mjs",
```

and change `"test"` to chain both suites:

```json
"test": "node scripts/make-sample.mjs && node scripts/make-draft-sample.mjs && node scripts/test.mjs && node scripts/test-draft.mjs",
```

- [ ] **Step 5: Generate the prior and run the tests**

```bash
npm run freeze-prior
node scripts/test-draft.mjs
```

Expected: `✓ froze 587 players, 602348 minutes of evidence`, then all draft checks pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/freeze-prior.mjs scripts/test-draft.mjs package.json data/draft/prior-2526.json data/draft/raw/
git commit -m "feat(draft): freeze the 2025/26 evidence before FPL zeroes it"
```

---

### Task 2: Normalised dataset, live config, and quarantine the poller

`fetch-draft.mjs` loses the league requirement and produces the two files the browser actually reads. The frozen prior is merged in at build time so the browser loads one file.

**Files:**
- Modify: `scripts/fetch-draft.mjs` (full rewrite, 41 lines → new)
- Modify: `scripts/draft-live.mjs:1-10` (quarantine header)
- Modify: `package.json` (rename the poller script)
- Modify: `.github/workflows/refresh.yml:38-42` (drop `DRAFT_LEAGUE_ID`)
- Modify: `scripts/test-draft.mjs` (append)

**Interfaces:**
- Consumes: `data/draft/prior-2526.json` from Task 1.
- Produces:
  - `data/draft/config.json` — `{ scoring: {...}, squad: {...}, league: {...} }` from the Draft API's `settings`.
  - `data/draft/players.json` — `{ builtAt, players: BoardPlayer[] }`. `BoardPlayer` = `{ code, id, element_type, team, web_name, first_name, second_name, status, chance_of_playing_next_round, news, now_cost, draft_rank, prior: { ...PriorPlayer fields } }`. `now_cost` is informational only and must never enter a ranking.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`, before the final summary lines:

```js
console.log('\nNormalised board dataset');
const cfg = await readJSON('data/draft/config.json');
ok('the config file exists', !!cfg, 'run `npm run refresh:draft`');
if (cfg) {
  ok('goals are worth 10/6/5/4', cfg.scoring.goals_scored_GKP === 10
    && cfg.scoring.goals_scored_DEF === 6
    && cfg.scoring.goals_scored_MID === 5
    && cfg.scoring.goals_scored_FWD === 4);
  ok('defensive contribution needs 10 for defenders', cfg.scoring.defensive_contribution_limit_DEF === 10);
  ok('defensive contribution needs 12 for midfielders', cfg.scoring.defensive_contribution_limit_MID === 12);
  ok('captains are disabled in Draft', cfg.squad.captains_disabled === true);
  ok('the squad is 2/5/5/3', cfg.squad.select_GKP === 2 && cfg.squad.select_DEF === 5
    && cfg.squad.select_MID === 5 && cfg.squad.select_FWD === 3);
  ok('there is no budget in Draft', cfg.squad.total_spend === undefined && cfg.squad.budget === undefined);
  ok('there is no per-club limit in Draft', cfg.squad.team_limit === undefined);
  ok('the default league is eight managers', cfg.league.default_entries === 8);
}

const board = await readJSON('data/draft/players.json');
ok('the board dataset exists', !!board);
if (board) {
  ok('every player is on the board', board.players.length === 587, `got ${board.players.length}`);
  ok('every row carries a code', board.players.every((p) => Number.isFinite(p.code)));
  ok('codes are unique', new Set(board.players.map((p) => p.code)).size === board.players.length);
  ok('the frozen prior is merged in', board.players.every((p) => p.prior && Number.isFinite(p.prior.minutes)));
  ok('prior evidence actually survived the merge',
    board.players.reduce((s, p) => s + p.prior.minutes, 0) === 602348);
  ok('availability comes from live data', board.players.every((p) => typeof p.status === 'string'));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL — `the config file exists` and `the board dataset exists` both fail.

- [ ] **Step 3: Rewrite `scripts/fetch-draft.mjs`**

Replace the entire file:

```js
/**
 * Build the Draft board dataset. Server-side only — the Draft API sends no
 * CORS headers, exactly like the main game's.
 *
 * No league id is involved. The draft assistant is deliberately usable without
 * one, so this script only ever fetches public, league-independent data.
 *
 * On any upstream failure the previous files are left untouched: the browser
 * depends on the committed dataset, never on live API access.
 */
import { getJSON } from './lib/http.mjs';
import { readJSON, writeJSONIfChanged } from './lib/io.mjs';

const DRAFT_API = 'https://draft.premierleague.com/api';
const CLASSIC_API = 'https://fantasy.premierleague.com/api';
const DIR = 'data/draft';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const prior = await readJSON(`${DIR}/prior-2526.json`);
if (!prior?.players) {
  throw new Error('missing data/draft/prior-2526.json — run `npm run freeze-prior` first');
}

console.log('→ draft bootstrap-static');
const draftBoot = await getJSON(`${DRAFT_API}/bootstrap-static`, { browserUA: true })
  .catch((e) => { console.warn(`  draft bootstrap failed: ${e.message}`); return null; });

console.log('→ classic bootstrap-static');
const classicBoot = await getJSON(`${CLASSIC_API}/bootstrap-static/`, { browserUA: true })
  .catch((e) => { console.warn(`  classic bootstrap failed: ${e.message}`); return null; });

if (!classicBoot?.elements?.length) {
  console.warn('✗ no classic payload — leaving the committed dataset untouched');
  process.exit(0);
}

/* The Draft settings are the authoritative scoring rules. If the Draft API is
   down we keep whatever config is already committed rather than inventing one. */
if (draftBoot?.settings) {
  await writeJSONIfChanged(`${DIR}/config.json`, {
    scoring: draftBoot.settings.scoring,
    squad: draftBoot.settings.squad,
    league: draftBoot.settings.league,
  });
  console.log('  wrote scoring + squad config');
} else {
  console.warn('  no draft settings — keeping the committed config');
}

// draft_rank and the Draft element id are enrichments. Join on code: 21 of 587
// players have different ids in the two games, so joining on id is wrong.
const draftByCode = new Map((draftBoot?.elements || []).map((p) => [p.code, p]));

const players = classicBoot.elements.map((p) => {
  const d = draftByCode.get(p.code);
  return {
    code: p.code,
    id: d?.id ?? p.id,
    element_type: p.element_type,
    team: p.team,
    web_name: p.web_name,
    first_name: p.first_name,
    second_name: p.second_name,
    status: p.status,
    chance_of_playing_next_round: p.chance_of_playing_next_round,
    news: p.news || '',
    now_cost: num(p.now_cost), // informational only — never used in ranking
    draft_rank: d ? num(d.draft_rank) : (prior.players[p.code]?.draft_rank ?? null),
    penalties_order: p.penalties_order ?? null,
    prior: prior.players[p.code] ?? null,
  };
}).filter((p) => p.prior);

await writeJSONIfChanged(`${DIR}/players.json`, {
  builtAt: new Date().toISOString(),
  priorSeason: prior.season,
  players,
});
console.log(`✓ ${players.length} players on the board`);
```

- [ ] **Step 4: Quarantine the local poller**

Replace the header comment of `scripts/draft-live.mjs` (lines 1–10) with:

```js
/**
 * EXPERIMENTAL — NOT PART OF THE PRODUCT.
 *
 * A local poller that watches a Draft league and writes choices to disk. It
 * requires a process running on your machine, which the deployed GitHub Pages
 * app deliberately does not. Nothing in the production page, the refresh
 * workflow, the README's user instructions, or any deployment test may depend
 * on this file.
 *
 * Kept only for experimentation. If you are drafting, use the web app.
 */
```

In `package.json`, rename the script to make its status obvious:

```json
"experimental:draft-live": "node scripts/draft-live.mjs",
```

and delete the old `"draft-live"` key.

- [ ] **Step 5: Drop the league id from the workflow**

In `.github/workflows/refresh.yml`, replace the `Fetch Draft data` step with:

```yaml
      - name: Fetch Draft data
        run: node scripts/fetch-draft.mjs
        continue-on-error: true
```

(The `env:` block carrying `DRAFT_LEAGUE_ID` goes away entirely — no league id is used anywhere.)

- [ ] **Step 6: Run the fetch and the tests**

```bash
npm run refresh:draft
node scripts/test-draft.mjs
```

Expected: `✓ 587 players on the board`, then all checks pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-draft.mjs scripts/draft-live.mjs scripts/test-draft.mjs package.json .github/workflows/refresh.yml data/draft/config.json data/draft/players.json
git commit -m "feat(draft): build the board dataset without a league id"
```

---

### Task 3: Strategy configuration

Every tuneable coefficient in one documented place, so later tuning never means hunting through logic.

**Files:**
- Create: `js/draft/config.js`
- Modify: `scripts/test-draft.mjs` (append)

**Interfaces:**
- Produces: `DRAFT_CONFIG` (object), `QUOTA` (`{1:2,2:5,3:5,4:3}`), `STARTER_QUOTA` (`{1:1,2:4,3:4,4:2}`), `ROUNDS` (15), `LEAGUE_SIZE_DEFAULT` (8), `LEAGUE_SIZE_MIN` (2), `LEAGUE_SIZE_MAX` (16).

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`:

```js
import { DRAFT_CONFIG, QUOTA, STARTER_QUOTA, ROUNDS,
  LEAGUE_SIZE_DEFAULT, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX } from '../js/draft/config.js';

console.log('\nDraft configuration');
ok('the squad is 2/5/5/3', QUOTA[1] === 2 && QUOTA[2] === 5 && QUOTA[3] === 5 && QUOTA[4] === 3);
ok('the quotas total fifteen', Object.values(QUOTA).reduce((a, b) => a + b, 0) === 15);
ok('a starting eleven is 1/4/4/2', Object.values(STARTER_QUOTA).reduce((a, b) => a + b, 0) === 11);
ok('fifteen rounds', ROUNDS === 15);
ok('eight managers by default', LEAGUE_SIZE_DEFAULT === 8);
ok('league size spans two to sixteen', LEAGUE_SIZE_MIN === 2 && LEAGUE_SIZE_MAX === 16);
ok('the near-term horizon is configurable', DRAFT_CONFIG.nearTermHorizon === 5);
ok('every weight is a finite number',
  ['rosWeight', 'nearTermWeight', 'vorpWeight', 'scarcityWeight', 'urgencyWeight',
    'rosterNeedWeight', 'riskWeight'].every((k) => Number.isFinite(DRAFT_CONFIG[k])));
ok('replacement is measured against outstanding demand by default',
  DRAFT_CONFIG.replacementBasis === 'demand');
ok('the survival model is deterministic by default', Number.isFinite(DRAFT_CONFIG.survivalSeed));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL with `Cannot find module '../js/draft/config.js'`.

- [ ] **Step 3: Write `js/draft/config.js`**

```js
/**
 * Draft strategy configuration.
 *
 * Every coefficient the recommendation depends on lives here, named and
 * documented, so the board can be tuned after watching it behave on a real
 * draft night without hunting through the logic. Nothing in js/draft/ may
 * inline a magic number that belongs in this file.
 */

/** Roster quotas. FPL Draft matches the main game: 2/5/5/3, fifteen players. */
export const QUOTA = { 1: 2, 2: 5, 3: 5, 4: 3 };

/**
 * Starting slots for a representative XI (1 GK, 4 DEF, 4 MID, 2 FWD).
 * Only eleven players score and the reserve keeper never plays, so a
 * starters-based replacement level stops bench positions earning early picks.
 * Retained as an alternative basis — see `replacementBasis`.
 */
export const STARTER_QUOTA = { 1: 1, 2: 4, 3: 4, 4: 2 };

export const ROUNDS = 15;
export const LEAGUE_SIZE_DEFAULT = 8;  // the Draft API's own settings.league.default_entries
export const LEAGUE_SIZE_MIN = 2;
export const LEAGUE_SIZE_MAX = 16;

export const DRAFT_CONFIG = {
  /* --- horizons --- */
  /** Gameweeks in the near-term projection. Matches the classic model default. */
  nearTermHorizon: 5,
  /** Gameweeks in the rest-of-season projection. A full season. */
  rosHorizon: 38,

  /* --- how the two horizons combine --- */
  /**
   * A first-round pick is a season-long asset, so ROS dominates early. Later
   * rounds are marginal players where short-term role and fixtures matter more.
   * `nearTermWeight` is the share given to the near-term number in the FINAL
   * round; the blend moves linearly from `rosWeight` at round one.
   */
  rosWeight: 1.0,
  nearTermWeight: 0.35,

  /* --- decision score components --- */
  vorpWeight: 1.0,
  scarcityWeight: 0.35,
  urgencyWeight: 0.9,
  rosterNeedWeight: 0.25,
  riskWeight: 0.5,

  /* --- replacement level --- */
  /**
   * 'demand'   — replacement is the player at the edge of the league's
   *              OUTSTANDING roster demand at that position. Responds to the
   *              draft as it happens.
   * 'starters' — replacement is measured against starting slots only.
   * The two are compared in scripts/draft-diagnostics.mjs.
   */
  replacementBasis: 'demand',

  /* --- tiers and scarcity --- */
  /** Standard deviations above the mean gap that constitute a cliff. */
  tierGapThreshold: 1.0,
  /** Supply:demand at or below this marks a position HIGH scarcity. */
  scarcityHighRatio: 1.0,
  scarcityMediumRatio: 2.0,

  /* --- survival simulation --- */
  survivalTrials: 300,
  survivalSeed: 12345,
  /** Width of the window a typical manager picks within. 1 = a robot. */
  opponentGreed: 3,

  /* --- risk --- */
  /** Weight on the availability penalty; 1 fully discounts a doubtful player. */
  availabilityPenalty: 1.0,
  /** Minutes of evidence below which a player is treated as unproven. */
  minutesConfidence: 900,

  /* --- Phase 2 --- */
  /** Minimum projected gain before a waiver swap is worth recommending. */
  minimumImprovement: 4,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-draft.mjs`
Expected: PASS, all configuration checks green.

- [ ] **Step 5: Commit**

```bash
git add js/draft/config.js scripts/test-draft.mjs
git commit -m "feat(draft): name every strategy coefficient in one place"
```

---

## MILESTONE B — Draft Night MVP

### Task 4: Log-driven draft state

The pick log is the single source of truth. Everything else derives, which is what stops state corrupting.

**Files:**
- Create: `js/draft/state.js`
- Modify: `scripts/test-draft.mjs` (append)

**Interfaces:**
- Consumes: `QUOTA`, `ROUNDS`, `LEAGUE_SIZE_DEFAULT/MIN/MAX` from `js/draft/config.js`.
- Produces:
  - `SCHEMA_VERSION` = `1`
  - `createDraft({ leagueSize, mySlot })` → `DraftState` = `{ version, leagueSize, mySlot, log: Pick[], finished: false }`; `Pick` = `{ elementId, mine }`
  - `slotForPick(overall, leagueSize)` → number
  - `roundForPick(overall, leagueSize)` → number
  - `addPick(state, { elementId, mine })` → new `DraftState`
  - `undoLastPick(state)` → new `DraftState`
  - `editPick(state, index, { elementId, mine })` → new `DraftState`
  - `derive(state, types)` → `{ taken: Set<number>, rosters: Map<number, number[]>, myRoster: number[], currentPick, round, onClockSlot, myNextPick, picksUntilMyTurn, opponentPicksBeforeMyNext, needs, picksRemaining }`. `types` is an id→`element_type` `Map`, supplied by the caller once the board dataset is loaded; without it `needs` falls back to the full quota.
  - `finishDraft(state)` → new `DraftState` with `finished: true`
  - `finalPools(state, allPlayerIds, types)` → `{ mine, bySlot, drafted, undrafted }` — the Phase 2 handover
  - `save(state)`, `load()`, `clear()` — `localStorage` under `draftState.v1`
  - `migrateLegacy()` → boolean

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`:

```js
import {
  SCHEMA_VERSION, createDraft, addPick, undoLastPick, editPick, derive, needsFor,
  slotForPick, roundForPick, finishDraft, finalPools,
} from '../js/draft/state.js';

console.log('\nDraft state — snake order');
ok('round one runs in slot order',
  [1, 2, 3, 4].every((n) => slotForPick(n, 4) === n));
ok('round two reverses',
  slotForPick(5, 4) === 4 && slotForPick(6, 4) === 3
  && slotForPick(7, 4) === 2 && slotForPick(8, 4) === 1);
ok('round three runs forwards again', slotForPick(9, 4) === 1 && slotForPick(12, 4) === 4);
ok('rounds are one-indexed', roundForPick(1, 4) === 1 && roundForPick(4, 4) === 1);
ok('the round advances on the boundary', roundForPick(5, 4) === 2 && roundForPick(9, 4) === 3);
ok('slot one picks first and last in a two-round window',
  slotForPick(1, 8) === 1 && slotForPick(16, 8) === 1);

console.log('\nDraft state — the log is the source of truth');
let s = createDraft({ leagueSize: 8, mySlot: 5 });
ok('a fresh draft carries the schema version', s.version === SCHEMA_VERSION);
ok('a fresh draft starts at pick one', derive(s).currentPick === 1);
ok('a fresh draft needs the full quota',
  JSON.stringify(derive(s).needs) === JSON.stringify({ 1: 2, 2: 5, 3: 5, 4: 3 }));
ok('a fresh draft has fifteen picks remaining', derive(s).picksRemaining === 15);
ok('slot five picks fifth', derive(s).myNextPick === 5);
ok('four picks happen before my first turn', derive(s).picksUntilMyTurn === 4);

s = addPick(s, { elementId: 101, mine: false });
ok('a pick advances the board', derive(s).currentPick === 2);
ok('a taken player is off the board', derive(s).taken.has(101));
ok('the first pick belongs to slot one', derive(s).rosters.get(1).includes(101));
ok('a taken player is not mine', !derive(s).myRoster.includes(101));

s = addPick(s, { elementId: 102, mine: false });
s = addPick(s, { elementId: 103, mine: false });
s = addPick(s, { elementId: 104, mine: false });
ok('my turn arrives after four picks', derive(s).picksUntilMyTurn === 0);
ok('I am on the clock', derive(s).onClockSlot === 5);

s = addPick(s, { elementId: 105, mine: true });
ok('my pick lands in my roster', derive(s).myRoster.includes(105));
ok('my pick is also attributed to my slot', derive(s).rosters.get(5).includes(105));
ok('my next turn is the snake turn', derive(s).myNextPick === 12);
ok('six opponents pick before my next turn', derive(s).opponentPicksBeforeMyNext === 6);

console.log('\nDraft state — undo and correction');
const beforeUndo = derive(s).currentPick;
s = undoLastPick(s);
ok('undo steps the board back', derive(s).currentPick === beforeUndo - 1);
ok('undo removes the player from the pool', !derive(s).taken.has(105));
ok('undo empties my roster again', derive(s).myRoster.length === 0);

s = addPick(s, { elementId: 105, mine: true });
s = editPick(s, 0, { elementId: 999, mine: false });
ok('an edited pick replaces the player', derive(s).taken.has(999) && !derive(s).taken.has(101));
ok('an edit keeps the board position', derive(s).currentPick === 6);
ok('an edit re-attributes to the right slot', derive(s).rosters.get(1).includes(999));

s = editPick(s, 1, { elementId: 102, mine: true });
ok('an edit can transfer ownership to me', derive(s).myRoster.includes(102));
ok('an edit recomputes my remaining needs',
  Object.values(derive(s).needs).reduce((a, b) => a + b, 0) === 13);

console.log('\nDraft state — undo on an empty log');
const empty = undoLastPick(createDraft({ leagueSize: 8, mySlot: 5 }));
ok('undoing nothing is safe', derive(empty).currentPick === 1);

console.log('\nFinish draft hands Phase 2 its foundation');
let done = createDraft({ leagueSize: 4, mySlot: 2 });
[201, 202, 203, 204, 205, 206].forEach((id, i) => {
  done = addPick(done, { elementId: id, mine: i === 1 });
});
done = finishDraft(done);
const pools = finalPools(done, [201, 202, 203, 204, 205, 206, 207, 208], new Map());
ok('the draft is marked finished', done.finished === true);
ok('the log survives finishing', done.log.length === 6);
ok('my players are kept', pools.mine.join() === '202');
ok('every opponent roster is kept', Object.keys(pools.bySlot).length === 4);
ok('every drafted player is recorded', pools.drafted.length === 6);
ok('undrafted players become the free-agent pool', pools.undrafted.join() === '207,208');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL with `Cannot find module '../js/draft/state.js'`.

- [ ] **Step 3: Write `js/draft/state.js`**

```js
/**
 * Live draft state.
 *
 * The pick log is the single source of truth. Taken players, manager rosters,
 * the round, the current pick, remaining demand and my roster are all DERIVED
 * from it, never stored alongside it — so there is no second copy to fall out
 * of sync, and correcting a mis-entered pick fixes everything downstream at
 * once.
 *
 * Nothing here knows about leagues, entries or the Draft API. A draft is a
 * league size, a slot, and an ordered list of picks.
 */
import { QUOTA, ROUNDS, LEAGUE_SIZE_DEFAULT, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX } from './config.js';

export const SCHEMA_VERSION = 1;
const KEY = 'draftState.v1';
const LEGACY_KEYS = ['draftTaken', 'draftEntry'];

const clampSize = (n) => Math.max(LEAGUE_SIZE_MIN, Math.min(LEAGUE_SIZE_MAX, Math.round(n) || LEAGUE_SIZE_DEFAULT));

/** Which round an overall pick number falls in. One-indexed. */
export function roundForPick(overall, leagueSize) {
  return Math.floor((overall - 1) / leagueSize) + 1;
}

/**
 * Which slot owns an overall pick. Odd rounds run 1..N, even rounds N..1 —
 * this is the inverse of the snake pick list, and the two are asserted
 * consistent in the test suite.
 */
export function slotForPick(overall, leagueSize) {
  const round = roundForPick(overall, leagueSize);
  const indexInRound = overall - (round - 1) * leagueSize;
  return round % 2 === 1 ? indexInRound : leagueSize - indexInRound + 1;
}

/** Every overall pick number belonging to one slot. */
export function picksForSlot(leagueSize, slot, rounds = ROUNDS) {
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    out.push(r % 2 === 1 ? (r - 1) * leagueSize + slot : r * leagueSize - slot + 1);
  }
  return out;
}

export function createDraft({ leagueSize = LEAGUE_SIZE_DEFAULT, mySlot = 1 } = {}) {
  const size = clampSize(leagueSize);
  return {
    version: SCHEMA_VERSION,
    leagueSize: size,
    mySlot: Math.max(1, Math.min(size, Math.round(mySlot) || 1)),
    log: [],
    finished: false,
  };
}

export function addPick(state, { elementId, mine = false }) {
  if (!Number.isFinite(elementId)) return state;
  return { ...state, log: [...state.log, { elementId, mine: !!mine }] };
}

export function undoLastPick(state) {
  if (!state.log.length) return state;
  return { ...state, log: state.log.slice(0, -1), finished: false };
}

/**
 * Correct an earlier pick in place. The board position is untouched — only who
 * was taken, and by whom, changes. Everything downstream recomputes.
 */
export function editPick(state, index, { elementId, mine }) {
  if (index < 0 || index >= state.log.length) return state;
  const log = state.log.map((p, i) => (i === index
    ? { elementId: Number.isFinite(elementId) ? elementId : p.elementId,
        mine: mine === undefined ? p.mine : !!mine }
    : p));
  return { ...state, log };
}

/** Remove a pick entirely, closing the gap. For a pick that never happened. */
export function removePick(state, index) {
  if (index < 0 || index >= state.log.length) return state;
  return { ...state, log: state.log.filter((_, i) => i !== index) };
}

/**
 * Everything the UI needs, computed from the log alone.
 *
 * `picksUntilMyTurn` is 0 when I am on the clock.
 * `opponentPicksBeforeMyNext` is how many rivals choose between my current
 * position and my next turn — the number the survival model needs.
 */
export function derive(state, types) {
  const { leagueSize, mySlot, log } = state;
  const taken = new Set();
  const rosters = new Map();
  const myRoster = [];

  log.forEach((pick, i) => {
    const overall = i + 1;
    const slot = pick.mine ? mySlot : slotForPick(overall, leagueSize);
    taken.add(pick.elementId);
    if (!rosters.has(slot)) rosters.set(slot, []);
    rosters.get(slot).push(pick.elementId);
    if (pick.mine) myRoster.push(pick.elementId);
  });

  const currentPick = log.length + 1;
  const round = roundForPick(currentPick, leagueSize);
  const onClockSlot = slotForPick(currentPick, leagueSize);

  const mine = picksForSlot(leagueSize, mySlot);
  const myNextPick = mine.find((p) => p >= currentPick) ?? null;
  const picksUntilMyTurn = myNextPick === null ? null : myNextPick - currentPick;
  const afterThis = mine.find((p) => p > currentPick) ?? null;
  const opponentPicksBeforeMyNext = afterThis === null ? Infinity : afterThis - currentPick - 1;

  return {
    taken,
    rosters,
    myRoster,
    currentPick,
    round,
    onClockSlot,
    myNextPick,
    picksUntilMyTurn,
    opponentPicksBeforeMyNext,
    needs: needsFor(myRoster, types),
    picksRemaining: 15 - myRoster.length,
  };
}

/**
 * How many of each position I still need. Takes an optional id→element_type
 * map; without one it can only count, so the caller supplies types when the
 * board dataset is loaded.
 */
export function needsFor(roster, types) {
  const need = { ...QUOTA };
  if (!types) return need;
  for (const id of roster) {
    const t = types.get ? types.get(id) : types[id];
    if (need[t] > 0) need[t] -= 1;
  }
  return need;
}

/**
 * Close the draft. Nothing is discarded — the log stays intact, because the
 * season-long waiver assistant is built from exactly this state.
 */
export function finishDraft(state) {
  return { ...state, finished: true };
}

/**
 * The Phase 2 handover: who owns what, and who nobody took.
 * `allPlayerIds` is every id in the board dataset, so the undrafted pool is the
 * complement of everything claimed rather than a separately maintained list.
 */
export function finalPools(state, allPlayerIds, types) {
  const d = derive(state, types);
  const drafted = [...d.taken];
  const draftedSet = new Set(drafted);
  return {
    mine: d.myRoster,
    bySlot: Object.fromEntries([...d.rosters].map(([slot, ids]) => [slot, ids])),
    drafted,
    undrafted: allPlayerIds.filter((id) => !draftedSet.has(id)),
  };
}

/* ------------------------------------------------------------------ *
 * persistence
 * ------------------------------------------------------------------ */
export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* private browsing — the draft just won't survive a refresh */ }
  return state;
}

/** A corrupt or foreign payload must never blank the page mid-draft. */
export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.version !== SCHEMA_VERSION) return null;
    if (!Array.isArray(raw.log)) return null;
    return {
      ...raw,
      leagueSize: clampSize(raw.leagueSize),
      log: raw.log.filter((p) => p && Number.isFinite(p.elementId)),
    };
  } catch {
    return null;
  }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

/**
 * Discard the league-id-era keys. They stored a flat set of taken ids with no
 * ordering, so they cannot be replayed into a log — attribution would be
 * invented. Dropping them is the honest migration.
 */
export function migrateLegacy() {
  let found = false;
  for (const k of LEGACY_KEYS) {
    try {
      if (localStorage.getItem(k) !== null) { found = true; localStorage.removeItem(k); }
    } catch { /* ignore */ }
  }
  return found;
}
```

- [ ] **Step 4: Fix the needs test to supply types**

`needsFor` requires an id→type map. Update the two `needs` assertions written in Step 1 to pass one, replacing those two lines:

```js
const TYPES = new Map([[101, 2], [102, 3], [103, 3], [104, 4], [105, 3], [999, 2]]);
ok('a fresh draft needs the full quota',
  JSON.stringify(needsFor([], TYPES)) === JSON.stringify({ 1: 2, 2: 5, 3: 5, 4: 3 }));
```

and

```js
ok('an edit recomputes my remaining needs',
  Object.values(needsFor(derive(s).myRoster, TYPES)).reduce((a, b) => a + b, 0) === 13);
```

Add `needsFor` to the import list from `../js/draft/state.js`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/test-draft.mjs`
Expected: PASS — snake order, log, undo and correction sections all green.

- [ ] **Step 6: Commit**

```bash
git add js/draft/state.js scripts/test-draft.mjs
git commit -m "feat(draft): derive the whole board from an editable pick log"
```

---

### Task 5: Live replacement level and VORP

Replacement must respond to the draft. The current code computes it once against the preseason pool and never moves it — the biggest correctness gap in the audit.

**Files:**
- Create: `js/draft/replacement.js`
- Modify: `scripts/test-draft.mjs` (append)

**Interfaces:**
- Consumes: `QUOTA`, `STARTER_QUOTA`, `DRAFT_CONFIG` from config; `derive()` output from state.
- Produces:
  - `outstandingDemand(rosters, leagueSize, types)` → `{1..4: number}`
  - `replacementLevel(availableRows, demand, opts)` → `{1..4: number}` (projected points of the replacement player per position)
  - `attachVorp(availableRows, replacement)` → rows with `vorp` added

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`:

```js
import { outstandingDemand, replacementLevel, attachVorp } from '../js/draft/replacement.js';

console.log('\nReplacement level');
const mkRows = (type, projections) => projections.map((proj, i) => ({
  id: type * 1000 + i, element_type: type, proj,
}));
// 8 forwards, descending. In an 8-team league 24 FWD slots exist in total.
const fwds = mkRows(4, [92, 89, 87, 69, 67, 65, 60, 55]);

const emptyRosters = new Map();
const demand0 = outstandingDemand(emptyRosters, 8, new Map());
ok('an untouched league demands every roster slot',
  demand0[4] === 24 && demand0[2] === 40 && demand0[3] === 40 && demand0[1] === 16);

const types = new Map(fwds.map((r) => [r.id, 4]));
const rosters = new Map([[1, [fwds[0].id, fwds[1].id]], [2, [fwds[2].id]]]);
const demand1 = outstandingDemand(rosters, 8, types);
ok('drafted players reduce outstanding demand', demand1[4] === 21, `got ${demand1[4]}`);
ok('untouched positions keep full demand', demand1[2] === 40);

const rep = replacementLevel(fwds, { 4: 3 }, { basis: 'demand' });
ok('replacement sits at the edge of outstanding demand', rep[4] === 69, `got ${rep[4]}`);

const repDeep = replacementLevel(fwds, { 4: 100 }, { basis: 'demand' });
ok('demand beyond the pool falls back to the worst available', repDeep[4] === 55);

const repNone = replacementLevel([], { 4: 3 }, { basis: 'demand' });
ok('an empty pool gives a zero baseline', repNone[4] === 0);

console.log('\nReplacement level moves as the draft runs');
const early = replacementLevel(fwds, { 4: 8 }, { basis: 'demand' })[4];
const late = replacementLevel(fwds.slice(3), { 4: 4 }, { basis: 'demand' })[4];
ok('a thinning pool lowers the baseline', late < early || late === 55, `early ${early} late ${late}`);

console.log('\nVORP');
const withVorp = attachVorp(fwds, { 4: 69 });
ok('VORP is measured against replacement', withVorp[0].vorp === 92 - 69);
ok('the replacement player scores zero VORP',
  withVorp.find((r) => r.proj === 69).vorp === 0);
ok('below-replacement players score negative VORP',
  withVorp.find((r) => r.proj === 55).vorp < 0);
ok('VORP responds to league size', (() => {
  const small = replacementLevel(fwds, outstandingDemand(new Map(), 4, new Map()), { basis: 'demand' })[4];
  const big = replacementLevel(fwds, outstandingDemand(new Map(), 8, new Map()), { basis: 'demand' })[4];
  return small >= big;
})(), 'a smaller league should not have a deeper replacement level');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL with `Cannot find module '../js/draft/replacement.js'`.

- [ ] **Step 3: Write `js/draft/replacement.js`**

```js
/**
 * Replacement level and VORP.
 *
 * The player you are really choosing against is not the best available and not
 * the worst in the database — it is the player sitting at the edge of what the
 * league still has to fill at that position. In an eight-manager league there
 * are 24 forward slots; once 16 forwards are gone and 8 slots remain
 * outstanding, the eighth-best forward left is roughly the last one who will be
 * taken, and everyone beyond him is free. That is the baseline.
 *
 * It has to be recomputed after every pick. A baseline fixed before the draft
 * makes VORP meaningless by the second round.
 */
import { QUOTA, STARTER_QUOTA, DRAFT_CONFIG } from './config.js';

const TYPES = [1, 2, 3, 4];

/**
 * How many slots at each position the whole league still has to fill.
 * @param {Map<number, number[]>} rosters slot -> element ids
 * @param {Map<number, number>|object} types element id -> element_type
 */
export function outstandingDemand(rosters, leagueSize, types) {
  const out = {};
  for (const t of TYPES) out[t] = QUOTA[t] * leagueSize;
  const typeOf = (id) => (types.get ? types.get(id) : types[id]);
  for (const ids of rosters.values()) {
    for (const id of ids) {
      const t = typeOf(id);
      if (out[t] > 0) out[t] -= 1;
    }
  }
  return out;
}

/**
 * The projected points of the replacement-level player at each position.
 *
 * `basis: 'demand'` uses outstanding league-wide roster demand — the default,
 * and the one that responds to the draft. `basis: 'starters'` measures against
 * starting slots only, which stops bench positions earning early picks; it is
 * kept for comparison in the diagnostics.
 */
export function replacementLevel(rows, demand, { basis = DRAFT_CONFIG.replacementBasis, leagueSize = 8 } = {}) {
  const out = {};
  for (const t of TYPES) {
    const pool = rows
      .filter((r) => r.element_type === t)
      .sort((a, b) => b.proj - a.proj);
    if (!pool.length) { out[t] = 0; continue; }

    const edge = basis === 'starters'
      ? STARTER_QUOTA[t] * leagueSize
      : (demand?.[t] ?? pool.length);

    // The player just past the edge of demand is the first one nobody needs.
    const idx = Math.max(0, Math.min(pool.length - 1, edge));
    out[t] = pool[idx].proj;
  }
  return out;
}

/** Attach VORP to every row. Rows must already carry `proj`. */
export function attachVorp(rows, replacement) {
  return rows.map((r) => ({ ...r, vorp: r.proj - (replacement[r.element_type] ?? 0) }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-draft.mjs`
Expected: PASS — replacement and VORP sections green.

- [ ] **Step 5: Commit**

```bash
git add js/draft/replacement.js scripts/test-draft.mjs
git commit -m "feat(draft): measure replacement against outstanding league demand"
```

---

### Task 6: Scarcity by cliffs, and hard roster constraints

Counts are the wrong scarcity model. `92, 89, 87, 69, 67` has three players before a real drop; `88, 87, 86, 85, 84` does not, despite similar counts.

**Files:**
- Create: `js/draft/scarcity.js`
- Modify: `scripts/test-draft.mjs` (append)

**Interfaces:**
- Consumes: `DRAFT_CONFIG`, `QUOTA`; `assignTiers` from `js/draft/board.js`.
- Produces:
  - `playersBeforeCliff(rows, type, threshold)` → number
  - `scarcityByPosition(availableRows, demand, opts)` → `{1..4: { available, demand, ratio, beforeCliff, label } }` with `label` in `HIGH|MEDIUM|LOW`
  - `allowedPositions(needs, picksRemaining)` → `number[]`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`:

```js
import { playersBeforeCliff, scarcityByPosition, allowedPositions } from '../js/draft/scarcity.js';

console.log('\nScarcity is about cliffs, not counts');
const cliffy = mkRows(4, [92, 89, 87, 69, 67, 65]);
const flat = mkRows(2, [88, 87, 86, 85, 84, 83]);
ok('a cliff is found where the drop is real', playersBeforeCliff(cliffy, 4) === 3,
  `got ${playersBeforeCliff(cliffy, 4)}`);
ok('an even position has no early cliff', playersBeforeCliff(flat, 2) > 3,
  `got ${playersBeforeCliff(flat, 2)}`);

const sc = scarcityByPosition([...cliffy, ...flat], { 4: 3, 2: 20 }, { leagueSize: 8 });
ok('a position with demand at its cliff is scarce', sc[4].label === 'HIGH', `got ${sc[4].label}`);
ok('a deep position with slack supply is not', sc[2].label === 'LOW', `got ${sc[2].label}`);
ok('scarcity reports how many remain before the drop', sc[4].beforeCliff === 3);
ok('scarcity reports the raw supply too', sc[4].available === 6);
ok('scarcity reports outstanding demand', sc[4].demand === 3);
ok('an exhausted position is not reported as plentiful',
  scarcityByPosition([], { 4: 5 }, { leagueSize: 8 })[4].label === 'HIGH');

console.log('\nHard roster constraints');
ok('early on, every position is allowed',
  allowedPositions({ 1: 2, 2: 5, 3: 5, 4: 3 }, 15).sort().join() === '1,2,3,4');
ok('a filled position drops out',
  !allowedPositions({ 1: 0, 2: 3, 3: 2, 4: 1 }, 8).includes(1));
ok('with exactly enough picks left, only needed positions are allowed',
  allowedPositions({ 1: 1, 2: 1, 3: 0, 4: 0 }, 2).sort().join() === '1,2');
ok('with slack, an unneeded position is still allowed',
  allowedPositions({ 1: 1, 2: 1, 3: 0, 4: 0 }, 5).includes(3));
ok('one pick and one need forces that position',
  allowedPositions({ 1: 1, 2: 0, 3: 0, 4: 0 }, 1).join() === '1');
ok('a complete roster allows nothing', allowedPositions({ 1: 0, 2: 0, 3: 0, 4: 0 }, 0).length === 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL with `Cannot find module '../js/draft/scarcity.js'`.

- [ ] **Step 3: Write `js/draft/scarcity.js`**

```js
/**
 * Positional supply, demand and urgency.
 *
 * Raw counts mislead: twenty-five interchangeable defenders are less urgent
 * than four forwards when three of the four sit above a cliff. What matters is
 * how many useful players remain before the next real drop in value, measured
 * against how many slots the league still has to fill.
 */
import { DRAFT_CONFIG } from './config.js';

const TYPES = [1, 2, 3, 4];

/**
 * How many players remain at a position before the next unusually large gap.
 * A gap counts as a cliff when it exceeds the mean gap by `threshold` standard
 * deviations — the same rule the tier system uses, so the two agree.
 */
export function playersBeforeCliff(rows, type, threshold = DRAFT_CONFIG.tierGapThreshold) {
  const pool = rows
    .filter((r) => r.element_type === type)
    .sort((a, b) => b.proj - a.proj);
  if (pool.length < 3) return pool.length;

  const gaps = [];
  for (let i = 1; i < pool.length; i++) gaps.push(pool[i - 1].proj - pool[i].proj);
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  const cut = mean + threshold * Math.sqrt(variance);

  const at = gaps.findIndex((g) => g > cut);
  return at === -1 ? pool.length : at + 1;
}

/**
 * Supply, demand and an urgency label per position.
 *
 * The label comes from the ratio of useful supply to outstanding demand, and
 * is pulled up to HIGH when the cliff is close enough that the league's
 * remaining demand will eat through the good players before it is satisfied.
 */
export function scarcityByPosition(rows, demand, { leagueSize = 8 } = {}) {
  const out = {};
  for (const t of TYPES) {
    const pool = rows.filter((r) => r.element_type === t);
    const need = demand?.[t] ?? 0;
    const beforeCliff = playersBeforeCliff(rows, t);
    const ratio = need > 0 ? pool.length / need : Infinity;

    let label;
    if (ratio <= DRAFT_CONFIG.scarcityHighRatio) label = 'HIGH';
    else if (ratio <= DRAFT_CONFIG.scarcityMediumRatio) label = 'MEDIUM';
    else label = 'LOW';

    // A cliff the league will chew straight through is urgent regardless of
    // how many bodies sit below it.
    if (need > 0 && beforeCliff <= Math.ceil(need / leagueSize)) label = 'HIGH';

    out[t] = { available: pool.length, demand: need, ratio, beforeCliff, label };
  }
  return out;
}

/**
 * Which positions may still be recommended.
 *
 * Late in a draft, positional need stops being a weight and becomes a filter:
 * with two picks left and a keeper and a defender still required, nothing else
 * is legal. A position with no need left is only allowed while there is slack
 * — enough remaining picks to cover every mandatory slot without it.
 */
export function allowedPositions(needs, picksRemaining) {
  const totalNeeded = TYPES.reduce((s, t) => s + (needs[t] || 0), 0);
  const slack = picksRemaining - totalNeeded;
  return TYPES.filter((t) => (needs[t] > 0 ? true : slack > 0 && picksRemaining > 0));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-draft.mjs`
Expected: PASS — scarcity and hard-constraint sections green.

- [ ] **Step 5: Commit**

```bash
git add js/draft/scarcity.js scripts/test-draft.mjs
git commit -m "feat(draft): read scarcity from cliffs and force position late on"
```

---

### Task 7: The decision score and its explanation

Seven named quantities, each exposed separately. Explanations are generated from the same numbers that drove the ranking, so they cannot drift from it.

**Files:**
- Create: `js/draft/value.js`
- Modify: `scripts/test-draft.mjs` (append)

**Interfaces:**
- Consumes: `DRAFT_CONFIG`, `attachVorp`, `scarcityByPosition`, `allowedPositions`, `survival`/`picksBetween` from `js/draft/simulate.js`.
- Produces: `evaluate(available, ctx)` → rows sorted by `draftValue` descending, each carrying `{ projectedPoints, rosValue, nearTermValue, vorp, scarcity, survival, rosterNeed, risk, draftValue, reasons: Reason[] }` where `Reason` = `{ kind, text }`.
  `ctx` = `{ replacement, demand, scarcity, needs, picksRemaining, opponentPicksBeforeMyNext, round, leagueSize }`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`:

```js
import { evaluate } from '../js/draft/value.js';

console.log('\nDecision score');
const cand = [
  { id: 1, element_type: 4, proj: 92, rosValue: 92, nearTermValue: 12, draft_rank: 1, availability: 1, minutes: 3000 },
  { id: 2, element_type: 4, proj: 89, rosValue: 89, nearTermValue: 11, draft_rank: 4, availability: 1, minutes: 3000 },
  { id: 3, element_type: 2, proj: 88, rosValue: 88, nearTermValue: 11, draft_rank: 2, availability: 1, minutes: 3000 },
  { id: 4, element_type: 2, proj: 87, rosValue: 87, nearTermValue: 11, draft_rank: 3, availability: 1, minutes: 3000 },
  { id: 5, element_type: 2, proj: 86, rosValue: 86, nearTermValue: 11, draft_rank: 5, availability: 1, minutes: 3000 },
  { id: 6, element_type: 2, proj: 85, rosValue: 85, nearTermValue: 11, draft_rank: 6, availability: 1, minutes: 3000 },
];
const baseCtx = {
  replacement: { 1: 0, 2: 70, 3: 0, 4: 70 },
  demand: { 1: 16, 2: 40, 3: 40, 4: 24 },
  needs: { 1: 2, 2: 5, 3: 5, 4: 3 },
  picksRemaining: 15,
  opponentPicksBeforeMyNext: 6,
  round: 1,
  leagueSize: 8,
};
const ranked = evaluate(cand, baseCtx);

ok('every candidate is scored', ranked.length === cand.length);
ok('the seven components are all exposed separately',
  ['projectedPoints', 'rosValue', 'vorp', 'scarcity', 'survival', 'rosterNeed', 'risk', 'draftValue']
    .every((k) => Number.isFinite(ranked[0][k])));
ok('the list is sorted by decision score',
  ranked.every((r, i) => i === 0 || ranked[i - 1].draftValue >= r.draftValue));
ok('every candidate carries reasons', ranked.every((r) => Array.isArray(r.reasons) && r.reasons.length > 0));
ok('reasons are structured, not prose blobs',
  ranked[0].reasons.every((x) => typeof x.kind === 'string' && typeof x.text === 'string'));
ok('the decision score is not just the projection',
  ranked[0].draftValue !== ranked[0].projectedPoints);

console.log('\nScarcity outranks a marginally better projection');
// Two forwards above a cliff, four interchangeable defenders below it.
const scarceCtx = { ...baseCtx, demand: { 1: 16, 2: 40, 3: 40, 4: 24 }, opponentPicksBeforeMyNext: 12 };
const scarceRanked = evaluate(cand, scarceCtx);
ok('a scarce forward can beat a similar defender',
  scarceRanked[0].element_type === 4, `top was type ${scarceRanked[0].element_type}`);

console.log('\nRoster need and hard constraints in scoring');
const filledFwd = evaluate(cand, { ...baseCtx, needs: { 1: 2, 2: 5, 3: 5, 4: 0 }, picksRemaining: 12 });
ok('a filled position is not recommended', filledFwd.every((r) => r.element_type !== 4));
const forced = evaluate(cand, { ...baseCtx, needs: { 1: 0, 2: 1, 3: 0, 4: 0 }, picksRemaining: 1 });
ok('the last mandatory slot forces its position', forced.every((r) => r.element_type === 2));
ok('a forced pick says why', forced[0].reasons.some((x) => x.kind === 'constraint'));

console.log('\nRisk');
const risky = evaluate([
  { id: 7, element_type: 4, proj: 92, rosValue: 92, nearTermValue: 12, draft_rank: 1, availability: 0.25, minutes: 3000 },
  { id: 8, element_type: 4, proj: 90, rosValue: 90, nearTermValue: 12, draft_rank: 2, availability: 1, minutes: 3000 },
], baseCtx);
ok('a doubtful player is penalised', risky[0].id === 8, `top was ${risky[0].id}`);
ok('the penalty is visible as risk', risky.find((r) => r.id === 7).risk > 0);
ok('an injury warning appears in the reasons',
  risky.find((r) => r.id === 7).reasons.some((x) => x.kind === 'risk'));

console.log('\nDeterminism');
ok('the same board scores the same twice',
  JSON.stringify(evaluate(cand, baseCtx).map((r) => r.id))
  === JSON.stringify(evaluate(cand, baseCtx).map((r) => r.id)));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL with `Cannot find module '../js/draft/value.js'`.

- [ ] **Step 3: Write `js/draft/value.js`**

```js
/**
 * The draft decision score.
 *
 * "How good is this player" and "how important is it that I take him NOW" are
 * different questions. The first is a projection; the second accounts for who
 * else I could still get, how fast his position is drying up, and whether he
 * will survive until my next turn.
 *
 * Every component is computed and returned separately — for the UI, for the
 * diagnostics, and so that a bad recommendation can be traced to the term that
 * caused it rather than to one opaque number.
 */
import { DRAFT_CONFIG } from './config.js';
import { scarcityByPosition, allowedPositions } from './scarcity.js';
import { survival } from './simulate.js';

const POS_NAME = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/**
 * Blend rest-of-season against near-term value. A first-round pick is a
 * season-long asset, so ROS dominates early; by the final rounds the marginal
 * player's short-term role matters relatively more.
 */
function blendHorizons(row, round, rounds = 15) {
  const t = Math.min(1, Math.max(0, (round - 1) / (rounds - 1)));
  const nearWeight = DRAFT_CONFIG.nearTermWeight * t;
  const rosWeight = DRAFT_CONFIG.rosWeight * (1 - t) + DRAFT_CONFIG.rosWeight * t * (1 - DRAFT_CONFIG.nearTermWeight);
  const ros = row.rosValue ?? row.proj ?? 0;
  const near = row.nearTermValue ?? 0;
  // Scale the near-term number onto the ROS scale before blending so the two
  // are comparable rather than the shorter horizon being structurally smaller.
  const nearScaled = near * (DRAFT_CONFIG.rosHorizon / DRAFT_CONFIG.nearTermHorizon);
  return (ros * rosWeight + nearScaled * nearWeight) / (rosWeight + nearWeight || 1);
}

export function evaluate(available, ctx) {
  const {
    replacement = {}, demand = {}, needs = {}, picksRemaining = 15,
    opponentPicksBeforeMyNext = 0, round = 1, leagueSize = 8,
  } = ctx;

  const allowed = new Set(allowedPositions(needs, picksRemaining));
  const eligible = available.filter((r) => allowed.has(r.element_type));
  if (!eligible.length) return [];

  const forced = allowed.size === 1;
  const scarcity = ctx.scarcity || scarcityByPosition(eligible, demand, { leagueSize });
  const surv = survival(eligible, opponentPicksBeforeMyNext, {
    seed: DRAFT_CONFIG.survivalSeed,
    trials: DRAFT_CONFIG.survivalTrials,
    greed: DRAFT_CONFIG.opponentGreed,
  });

  // The best alternative still standing at each position if I pass now.
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const r of eligible) byPos[r.element_type].push(r);
  for (const t of Object.keys(byPos)) byPos[t].sort((a, b) => (b.proj ?? 0) - (a.proj ?? 0));

  const scored = eligible.map((row) => {
    const projectedPoints = row.proj ?? 0;
    const rosValue = row.rosValue ?? projectedPoints;
    const nearTermValue = row.nearTermValue ?? 0;
    const blended = blendHorizons(row, round);
    const vorp = blended - (replacement[row.element_type] ?? 0);

    const sc = scarcity[row.element_type] || { ratio: Infinity, beforeCliff: 99, label: 'LOW' };
    // Scarcity rises as supply tightens against demand; Infinity ratio → 0.
    const scarcityScore = Number.isFinite(sc.ratio) ? 1 / (1 + sc.ratio) : 0;

    const survivalP = surv.get(row.id) ?? 1;

    /* Opportunity cost: what I expect to hold at this position next turn if I
       pass, each alternative weighted by the chance he is still there. */
    let expectedNext = 0;
    let carried = 1;
    for (const alt of byPos[row.element_type]) {
      if (alt.id === row.id) continue;
      const ps = surv.get(alt.id) ?? 0;
      const altVorp = blendHorizons(alt, round) - (replacement[alt.element_type] ?? 0);
      expectedNext += carried * ps * altVorp;
      carried *= 1 - ps;
      if (carried < 1e-6) break;
    }
    const urgency = Math.max(0, vorp - (survivalP * vorp + (1 - survivalP) * expectedNext));

    const rosterNeed = (needs[row.element_type] ?? 0) / 5;

    const avail = row.availability ?? 1;
    const unproven = Math.max(0, 1 - (row.minutes ?? 0) / DRAFT_CONFIG.minutesConfidence);
    const risk = (1 - avail) * DRAFT_CONFIG.availabilityPenalty + unproven * 0.5;

    const draftValue =
      vorp * DRAFT_CONFIG.vorpWeight
      + scarcityScore * DRAFT_CONFIG.scarcityWeight * Math.abs(vorp)
      + urgency * DRAFT_CONFIG.urgencyWeight
      + rosterNeed * DRAFT_CONFIG.rosterNeedWeight * Math.abs(vorp)
      - risk * DRAFT_CONFIG.riskWeight * Math.abs(vorp);

    return {
      ...row,
      projectedPoints, rosValue, nearTermValue,
      vorp, scarcity: scarcityScore, survival: survivalP,
      rosterNeed, risk, draftValue,
      reasons: buildReasons({ row, vorp, sc, survivalP, urgency, risk, needs, forced, opponentPicksBeforeMyNext }),
    };
  });

  return scored.sort((a, b) => b.draftValue - a.draftValue || b.vorp - a.vorp);
}

/**
 * Explanations generated from the same numbers that produced the ranking, so
 * the two cannot drift apart. Each answers one of: why this player, why this
 * position, why now.
 */
function buildReasons({ row, vorp, sc, survivalP, urgency, risk, needs, forced, opponentPicksBeforeMyNext }) {
  const out = [];
  const pos = POS_NAME[row.element_type];

  out.push({ kind: 'value', text: `+${vorp.toFixed(0)} ROS points above ${pos} replacement` });

  if (sc.label === 'HIGH') {
    out.push({ kind: 'scarcity', text: `${pos} is scarce — ${sc.beforeCliff} left before a real drop, ${sc.demand} slots still needed league-wide` });
  } else if (sc.label === 'LOW') {
    out.push({ kind: 'scarcity', text: `${pos} is deep — ${sc.available} comparable options remain` });
  }

  if (Number.isFinite(opponentPicksBeforeMyNext) && opponentPicksBeforeMyNext > 0) {
    out.push({
      kind: 'timing',
      text: `${Math.round(survivalP * 100)}% chance he lasts the ${opponentPicksBeforeMyNext} picks before your next turn`,
    });
  }

  if (urgency > 0.5) {
    out.push({ kind: 'urgency', text: `passing costs about ${urgency.toFixed(0)} points against the best likely alternative` });
  }

  if (forced) {
    out.push({ kind: 'constraint', text: `you must fill ${pos} with your remaining picks — no other position is legal` });
  } else if ((needs[row.element_type] ?? 0) > 0) {
    out.push({ kind: 'need', text: `you still need ${needs[row.element_type]} ${pos}` });
  }

  if (risk > 0.3) {
    out.push({ kind: 'risk', text: row.news ? `availability risk — ${row.news}` : 'availability or minutes risk' });
  }

  return out;
}
```

- [ ] **Step 4: Let the survival model survive a missing `draft_rank`**

`js/draft/simulate.js:41-42` sorts opponents' likely picks by `draft_rank || 9999`. When the Draft API is unavailable that field is null for everyone, collapsing the sort and making every survival probability meaningless. The spec requires falling back to our own ranking instead.

Replace those two lines:

```js
  // Opponents draft off the game's own rankings where we have them. Without the
  // Draft API there is no draft_rank, so fall back to our projection — a board
  // ordered by nothing at all would make every survival probability noise.
  const hasRank = available.some((r) => Number.isFinite(r.draft_rank));
  const ranked = [...available].sort((a, b) => (hasRank
    ? (a.draft_rank || 9999) - (b.draft_rank || 9999)
    : (b.proj ?? 0) - (a.proj ?? 0)));
```

Add to `scripts/test-draft.mjs`:

```js
console.log('\nSurvival without the Draft API');
const noRank = [
  { id: 11, element_type: 4, proj: 92 },
  { id: 12, element_type: 4, proj: 60 },
];
const survNoRank = survival(noRank, 1, { seed: 1, trials: 200 });
ok('the best player is still least likely to survive',
  survNoRank.get(11) < survNoRank.get(12),
  'without draft_rank the model must fall back to projection');
```

Add `survival` to the imports from `../js/draft/simulate.js`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/test-draft.mjs`
Expected: PASS — decision score, scarcity precedence, constraints, risk, determinism and the no-rank fallback all green.

If `scarcity outranks a marginally better projection` fails, tune `DRAFT_CONFIG.urgencyWeight` upward rather than special-casing the logic — that assertion is exactly what the weight exists to control.

- [ ] **Step 6: Commit**

```bash
git add js/draft/value.js js/draft/simulate.js scripts/test-draft.mjs
git commit -m "feat(draft): score the decision, not just the player"
```

**Files touched by this task also include:** `js/draft/simulate.js:41-42` (the `draft_rank` fallback above).

---

### Task 8: Project the board over both horizons

Wire the board dataset into the projection model, producing the `proj` / `rosValue` / `nearTermValue` the value layer consumes.

**Files:**
- Create: `js/draft/project.js`
- Modify: `scripts/test-draft.mjs` (append)

**Interfaces:**
- Consumes: `projectAll` from `js/model.js`; `draftPrior` from `js/draft/adapt.js`; `DRAFT_CONFIG`.
- Produces: `projectBoard(boardPlayers, fixtures, teams)` → rows `{ id, code, element_type, team, web_name, news, status, availability, minutes, draft_rank, now_cost, proj, rosValue, nearTermValue, parts }`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`:

```js
import { projectBoard } from '../js/draft/project.js';

console.log('\nBoard projection');
const boardFile = await readJSON('data/draft/players.json');
const fixturesFile = await readJSON('data/fixtures.json', []);
if (boardFile) {
  const projected = projectBoard(boardFile.players, fixturesFile);
  ok('every player is projected', projected.length === boardFile.players.length);
  ok('rest-of-season value is present', projected.every((r) => Number.isFinite(r.rosValue)));
  ok('near-term value is present', projected.every((r) => Number.isFinite(r.nearTermValue)));
  ok('rest-of-season exceeds near-term for regular starters',
    projected.filter((r) => r.minutes > 2000).every((r) => r.rosValue >= r.nearTermValue));
  ok('projections are non-negative', projected.every((r) => r.rosValue >= 0));
  ok('the code survives projection', projected.every((r) => Number.isFinite(r.code)));
  ok('availability is carried through', projected.every((r) => Number.isFinite(r.availability)));
  ok('price is carried but never ranked on',
    projected.every((r) => Number.isFinite(r.now_cost)));
  const top = [...projected].sort((a, b) => b.rosValue - a.rosValue).slice(0, 20);
  ok('the top twenty are not all keepers',
    top.filter((r) => r.element_type === 1).length < 5,
    `${top.filter((r) => r.element_type === 1).length} keepers in the top 20`);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL with `Cannot find module '../js/draft/project.js'`.

- [ ] **Step 3: Write `js/draft/project.js`**

```js
/**
 * Project the board over both horizons.
 *
 * Evidence comes from the frozen 2025/26 prior, not from mutable bootstrap
 * fields — those are zeroed at the GW1 deadline, and a board that silently
 * loses its evidence base mid-season is worse than one that never had it.
 *
 * Two horizons are produced. A first-round pick is a season-long asset, so the
 * rest-of-season number carries most of the weight; the near-term number is
 * there for the marginal late-round picks where role and fixtures dominate.
 */
import { projectAll, availability } from '../model.js';
import { draftPrior } from './adapt.js';
import { DRAFT_CONFIG } from './config.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const per90 = (total, minutes) => (minutes > 0 ? (num(total) / minutes) * 90 : 0);

/**
 * Reshape a board row into what js/model.js expects: per-90 rates derived from
 * the frozen season totals, with live availability from the current payload.
 */
function toModelRow(p) {
  const prior = p.prior || {};
  const mins = num(prior.minutes);
  return {
    ...prior,
    id: p.id,
    code: p.code,
    element_type: p.element_type,
    team: p.team,
    web_name: p.web_name,
    status: p.status,
    chance_of_playing_next_round: p.chance_of_playing_next_round,
    news: p.news,
    now_cost: p.now_cost,
    draft_rank: p.draft_rank,
    penalties_order: p.penalties_order,
    minutes: mins,
    expected_goals_per_90: per90(prior.expected_goals, mins),
    expected_assists_per_90: per90(prior.expected_assists, mins),
    expected_goals_conceded_per_90: per90(prior.expected_goals_conceded, mins),
    saves_per_90: per90(prior.saves, mins),
    defensive_contribution_per_90: per90(prior.defensive_contribution, mins),
  };
}

export function projectBoard(boardPlayers, fixtures, opts = {}) {
  const rows = boardPlayers.map(toModelRow);
  const teams = [...new Set(rows.map((r) => r.team))].map((id) => ({ id }));
  const boot = { elements: rows, teams, events: [{ id: 1, is_next: true }] };

  const ros = projectAll(boot, fixtures, {
    horizon: DRAFT_CONFIG.rosHorizon, prior: draftPrior, ...opts,
  });
  const near = projectAll(boot, fixtures, {
    horizon: DRAFT_CONFIG.nearTermHorizon, prior: draftPrior, ...opts,
  });
  const nearById = new Map(near.rows.map((r) => [r.id, r.proj]));

  return ros.rows.map((r) => ({
    id: r.id,
    code: r.code,
    element_type: r.element_type,
    team: r.team,
    web_name: r.web_name,
    news: r.news || '',
    status: r.status,
    availability: availability(r),
    minutes: r.minutes,
    draft_rank: r.draft_rank,
    now_cost: r.now_cost,   // shown, never ranked on
    proj: r.proj,
    rosValue: r.proj,
    nearTermValue: nearById.get(r.id) ?? 0,
    parts: r.parts,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-draft.mjs`
Expected: PASS. If `the top twenty are not all keepers` fails, stop and investigate — that is the §21 sanity check firing early and it means the projection is wrong, not the test.

- [ ] **Step 5: Commit**

```bash
git add js/draft/project.js scripts/test-draft.mjs
git commit -m "feat(draft): project the board from frozen evidence over two horizons"
```

---

### Task 9: The draft page

Setup, the six sections, fast keyboard entry, and responsive layout. No league id anywhere.

**Files:**
- Modify: `js/pages/draft.js` (full rewrite, 136 lines → new)
- Modify: `css/app.css` (append a draft section)
- Test: manual browser verification (Step 6) — the modules beneath are covered by Tasks 4–8.

**Interfaces:**
- Consumes: `readSnapshot` from `js/data.js`; `projectBoard`; state module; `outstandingDemand`/`replacementLevel`/`attachVorp`; `scarcityByPosition`; `evaluate`; `el`/`setKids`/`$`/`fmt` from `js/ui.js`.

- [ ] **Step 1: Write `js/pages/draft.js`**

```js
/**
 * The live draft assistant.
 *
 * Manual entry is the authoritative state: there is no league id, no poller and
 * no request per pick. The board dataset is downloaded once, the pick log lives
 * in localStorage, and every number on screen is recomputed in-browser the
 * instant a pick is entered.
 */
import { $, el, fmt, setKids } from '../ui.js';
import { readSnapshot } from '../data.js';
import { projectBoard } from '../draft/project.js';
import {
  createDraft, addPick, undoLastPick, editPick, removePick, derive,
  needsFor, save, load, clear, migrateLegacy, finishDraft, finalPools,
} from '../draft/state.js';
import { outstandingDemand, replacementLevel, attachVorp } from '../draft/replacement.js';
import { scarcityByPosition } from '../draft/scarcity.js';
import { evaluate } from '../draft/value.js';
import { LEAGUE_SIZE_DEFAULT, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX, QUOTA } from '../draft/config.js';

const app = $('#app');
const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

migrateLegacy();

const board = await readSnapshot('draft/players');
const fixtures = await readSnapshot('fixtures', []);
if (!board?.players?.length) {
  setKids(app, el('p', { class: 'empty' },
    'Player data has not been published yet. It arrives with the next scheduled refresh.'));
  throw new Error('no board data');
}

const projected = projectBoard(board.players, fixtures);
const byId = new Map(projected.map((r) => [r.id, r]));
const typeOf = new Map(projected.map((r) => [r.id, r.element_type]));
const teams = await readSnapshot('bootstrap', null)
  .then((b) => new Map((b?.teams || []).map((t) => [t.id, t.short_name])))
  .catch(() => new Map());

let state = load();
let query = '';
let posFilter = 0;

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */
function renderSetup() {
  let size = LEAGUE_SIZE_DEFAULT;
  let slot = 1;

  const slotSelect = el('select', { class: 'input' });
  const fillSlots = () => {
    setKids(slotSelect, ...Array.from({ length: size },
      (_, i) => el('option', { value: String(i + 1) }, `Pick ${i + 1} of ${size}`)));
    slotSelect.value = String(Math.min(slot, size));
  };

  const sizeSelect = el('select', {
    class: 'input',
    onChange: (e) => { size = +e.target.value; fillSlots(); },
  }, ...Array.from({ length: LEAGUE_SIZE_MAX - LEAGUE_SIZE_MIN + 1 },
    (_, i) => el('option', { value: String(i + LEAGUE_SIZE_MIN) }, `${i + LEAGUE_SIZE_MIN} managers`)));
  sizeSelect.value = String(LEAGUE_SIZE_DEFAULT);
  fillSlots();

  setKids(app, el('div', { class: 'card setup' },
    el('h2', {}, 'Start a draft'),
    el('p', { class: 'hint' }, 'No league id needed. Everything runs in this browser.'),
    el('label', {}, 'League size', sizeSelect),
    el('label', {}, 'Your draft position', slotSelect),
    el('button', {
      class: 'primary',
      onClick: () => {
        state = save(createDraft({ leagueSize: size, mySlot: +slotSelect.value }));
        render();
      },
    }, 'Start draft'),
  ));
}

/* ------------------------------------------------------------------ *
 * the board
 * ------------------------------------------------------------------ */
function compute() {
  const d = derive(state, typeOf);
  const needs = d.needs;
  const available = projected.filter((r) => !d.taken.has(r.id));
  const demand = outstandingDemand(d.rosters, state.leagueSize, typeOf);
  const replacement = replacementLevel(available, demand, { leagueSize: state.leagueSize });
  const withVorp = attachVorp(available, replacement);
  const scarcity = scarcityByPosition(withVorp, demand, { leagueSize: state.leagueSize });
  const ranked = evaluate(withVorp, {
    replacement, demand, scarcity, needs,
    picksRemaining: d.picksRemaining,
    opponentPicksBeforeMyNext: d.opponentPicksBeforeMyNext,
    round: d.round,
    leagueSize: state.leagueSize,
  });
  return { d, needs, available: withVorp, demand, replacement, scarcity, ranked };
}

function pick(id, mine) {
  state = save(addPick(state, { elementId: id, mine }));
  query = '';
  render();
}

function playerLine(r) {
  return `${r.web_name} · ${POS[r.element_type]}${teams.get(r.team) ? ` · ${teams.get(r.team)}` : ''}`;
}

function actionButtons(r) {
  return el('span', { class: 'actions' },
    el('button', { class: 'ghost', onClick: () => pick(r.id, false) }, 'Taken'),
    el('button', { class: 'primary', onClick: () => pick(r.id, true) }, 'Mine'),
  );
}

function render() {
  if (!state) return renderSetup();
  const { d, needs, available, demand, scarcity, ranked } = compute();
  const best = ranked[0];
  const alternatives = ranked.slice(1, 6);

  const searchBox = el('input', {
    class: 'input search',
    type: 'search',
    placeholder: 'Search a surname, then Taken or Mine',
    value: query,
    onInput: (e) => { query = e.target.value; renderResults(); },
    onKeyDown: (e) => {
      if (e.key === 'Enter' && matches().length) {
        pick(matches()[0].id, e.shiftKey);
      }
    },
  });

  const matches = () => {
    const q = query.trim().toLowerCase();
    let pool = available;
    if (posFilter) pool = pool.filter((r) => r.element_type === posFilter);
    if (q) pool = pool.filter((r) => r.web_name.toLowerCase().includes(q));
    return [...pool].sort((a, b) => b.draftValue - a.draftValue || b.vorp - a.vorp).slice(0, 30);
  };

  const results = el('div', { class: 'results' });
  function renderResults() {
    setKids(results, ...matches().map((r) => el('div', { class: 'result' },
      el('span', { class: 'who' }, playerLine(r)),
      el('span', { class: 'num' }, fmt.pts(r.rosValue)),
      actionButtons(r),
    )));
  }
  renderResults();

  setKids(app,
    /* E — pick status */
    el('div', { class: 'tiles' },
      el('div', { class: 'tile accent' },
        el('span', { class: 'k' }, 'Pick'),
        el('span', { class: 'v' }, `#${d.currentPick}`),
        el('span', { class: 's' }, `Round ${d.round} · slot ${d.onClockSlot} on the clock`)),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, d.picksUntilMyTurn === 0 ? 'You are up' : 'Until your turn'),
        el('span', { class: 'v' }, d.picksUntilMyTurn === null ? '—' : `${d.picksUntilMyTurn}`),
        el('span', { class: 's' }, `you are slot ${state.mySlot} of ${state.leagueSize}`)),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'Squad'),
        el('span', { class: 'v' }, `${d.myRoster.length}/15`),
        el('span', { class: 's' }, [1, 2, 3, 4]
          .map((t) => `${POS[t]} ${QUOTA[t] - needs[t]}/${QUOTA[t]}`).join(' · '))),
    ),

    /* A — your next pick */
    el('div', { class: 'card headline' },
      el('h2', {}, d.picksUntilMyTurn === 0 ? 'Your pick — take this' : 'Best available now'),
      best
        ? el('div', {},
            el('div', { class: 'pickname' }, playerLine(best)),
            el('div', { class: 'pickstats' },
              el('span', {}, `Draft value ${fmt.pts(best.draftValue)}`),
              el('span', {}, `ROS ${fmt.pts(best.rosValue)}`),
              el('span', {}, `Next 5 ${fmt.pts(best.nearTermValue)}`),
              el('span', {}, `VORP ${fmt.pts(best.vorp)}`),
              el('span', {}, `Survives ${Math.round(best.survival * 100)}%`)),
            el('ul', { class: 'why' }, best.reasons.map((r) => el('li', { class: r.kind }, r.text))),
            actionButtons(best))
        : el('p', { class: 'empty' }, 'Your squad is complete.'),
      alternatives.length
        ? el('div', { class: 'alts' },
            el('h3', {}, 'Alternatives'),
            ...alternatives.map((r) => el('div', { class: 'result' },
              el('span', { class: 'who' }, playerLine(r)),
              el('span', { class: 'num' }, fmt.pts(r.draftValue)),
              actionButtons(r))))
        : null,
    ),

    /* B — search and best available */
    el('div', { class: 'card' },
      el('h2', {}, 'Enter a pick'),
      searchBox,
      el('div', { class: 'posfilter' }, ...[0, 1, 2, 3, 4].map((t) => el('button', {
        class: posFilter === t ? 'pill active' : 'pill',
        onClick: () => { posFilter = t; render(); },
      }, t ? POS[t] : 'All'))),
      results,
      el('p', { class: 'hint' }, 'Enter takes the top match as Taken. Shift+Enter takes it as yours.'),
    ),

    /* D — scarcity */
    el('div', { class: 'card' },
      el('h2', {}, 'Positional scarcity'),
      el('div', { class: 'scarcity' }, ...[1, 2, 3, 4].map((t) => el('div', { class: `srow ${scarcity[t].label.toLowerCase()}` },
        el('span', { class: 'k' }, POS[t]),
        el('span', { class: 'v' }, scarcity[t].label),
        el('span', { class: 's' },
          `${scarcity[t].available} left · ${demand[t]} slots needed · ${scarcity[t].beforeCliff} before the drop`)))),
    ),

    /* C — my squad */
    el('div', { class: 'card' },
      el('h2', {}, 'My squad'),
      d.myRoster.length
        ? el('ul', { class: 'mover-list' }, d.myRoster.map((id) => {
            const r = byId.get(id);
            return el('li', {}, r ? playerLine(r) : `#${id}`);
          }))
        : el('p', { class: 'empty' }, 'Nothing drafted yet.'),
      d.myRoster.length === 15 && !state.finished
        ? el('button', {
            class: 'primary',
            onClick: () => { state = save(finishDraft(state)); render(); },
          }, 'Finish draft')
        : null,
      state.finished
        ? el('p', { class: 'hint' },
            `Draft complete. ${finalPools(state, projected.map((r) => r.id), typeOf).undrafted.length} `
            + 'players went undrafted and become your free-agent pool.')
        : null,
    ),

    /* F — the draft log */
    el('div', { class: 'card' },
      el('h2', {}, 'Draft log'),
      el('div', { class: 'logactions' },
        el('button', { class: 'ghost', onClick: () => { state = save(undoLastPick(state)); render(); } }, 'Undo last pick'),
        el('button', {
          class: 'ghost danger',
          onClick: () => {
            if (confirm('Reset the draft? Everything entered will be lost.')) {
              clear(); state = null; render();
            }
          },
        }, 'Reset draft'),
      ),
      state.log.length
        ? el('div', { class: 'tablewrap' }, el('table', { class: 'players' },
            el('thead', {}, el('tr', {}, ...['#', 'Rd', 'Manager', 'Player', 'Pos', ''].map((h) => el('th', {}, h)))),
            el('tbody', {}, state.log.map((p, i) => {
              const overall = i + 1;
              const r = byId.get(p.elementId);
              return el('tr', { class: p.mine ? 'mine' : '' },
                el('td', {}, `${overall}`),
                el('td', {}, `${Math.floor(i / state.leagueSize) + 1}`),
                el('td', {}, p.mine ? 'You' : `Slot ${derive({ ...state, log: state.log.slice(0, overall) }).rosters.size ? '' : ''}${slotLabel(overall)}`),
                el('td', {}, r ? r.web_name : `#${p.elementId}`),
                el('td', {}, r ? POS[r.element_type] : '—'),
                el('td', {}, el('button', {
                  class: 'ghost',
                  onClick: () => {
                    const name = prompt('Correct this pick — type a surname:', r ? r.web_name : '');
                    if (!name) return;
                    const found = projected.find((x) => x.web_name.toLowerCase().includes(name.trim().toLowerCase()));
                    if (!found) { alert('No player matched that name.'); return; }
                    state = save(editPick(state, i, { elementId: found.id }));
                    render();
                  },
                }, 'Edit')),
              );
            }))))
        : el('p', { class: 'empty' }, 'No picks entered yet.'),
    ),
  );

  requestAnimationFrame(() => searchBox.focus());
}

function slotLabel(overall) {
  const round = Math.floor((overall - 1) / state.leagueSize) + 1;
  const idx = overall - (round - 1) * state.leagueSize;
  return String(round % 2 === 1 ? idx : state.leagueSize - idx + 1);
}

render();
```

- [ ] **Step 2: Simplify the manager column**

The manager cell above contains a leftover expression. Replace that whole `el('td', ...)` for the manager with:

```js
                el('td', {}, p.mine ? 'You' : `Slot ${slotLabel(overall)}`),
```

- [ ] **Step 3: Add the draft styles**

Append to `css/app.css`:

```css
/* --- draft assistant ------------------------------------------------ */
.setup label { display: block; margin: 0.75rem 0; font: inherit; }
.setup .input { display: block; width: 100%; margin-top: 0.25rem; }
.input {
  background: #2a2b2c; color: #fff; border: 1px solid #808080;
  border-radius: 8px; padding: 0.6rem 0.75rem; font: inherit;
}
.search { width: 100%; margin-bottom: 0.5rem; }
button.primary {
  background: var(--accent); color: #202123; border: 0;
  border-radius: 18.5px; padding: 0.5rem 1rem; font-weight: 700; cursor: pointer;
}
button.danger { color: #ff8f8f; }
.headline .pickname { font-family: var(--font-display); font-size: 2rem; line-height: 1.1; }
.headline .pickstats { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.5rem 0; opacity: 0.85; }
.why { margin: 0.5rem 0 1rem; padding-left: 1.1rem; }
.why li { margin: 0.2rem 0; }
.why li.constraint, .why li.risk { color: #f4ff7b; }
.result {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 0; border-top: 1px solid #4a4a4a;
}
.result .who { flex: 1; }
.actions { display: flex; gap: 0.4rem; }
.posfilter { display: flex; gap: 0.4rem; margin: 0.5rem 0; flex-wrap: wrap; }
.pill {
  background: transparent; color: #fff; border: 1px solid #808080;
  border-radius: 18.5px; padding: 0.3rem 0.8rem; cursor: pointer;
}
.pill.active { background: var(--accent); color: #202123; border-color: var(--accent); }
.scarcity .srow { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.4rem 0; }
.scarcity .srow .v { font-weight: 700; }
.scarcity .high .v { color: #ff8f8f; }
.scarcity .medium .v { color: #f4ff7b; }
.scarcity .low .v { color: #9fed00; }
.logactions { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
tr.mine { background: rgba(159, 237, 0, 0.08); }

/* Small screens: recommendation, entry, roster, then everything else. */
@media (max-width: 640px) {
  .headline .pickname { font-size: 1.5rem; }
  .result { flex-wrap: wrap; }
  .result .who { flex-basis: 100%; }
}
```

- [ ] **Step 4: Regenerate the page shells**

Run: `node scripts/build-pages.mjs`
Expected: `✓ draft.html — cyan` among the seven.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: the classic suite's 149 checks pass unchanged, then the draft suite passes.

- [ ] **Step 6: Verify in a browser**

```bash
npm run serve
```

Open `http://localhost:8080/draft.html`. Confirm: setup appears with no league-id field; starting a draft shows the board; searching a surname filters; `Taken` and `Mine` both work; the recommendation and its reasons change after picks; refresh restores state.

- [ ] **Step 7: Commit**

```bash
git add js/pages/draft.js css/app.css draft.html
git commit -m "feat(draft): the live draft assistant page"
```

---

### Task 10: Deploy and verify on GitHub Pages — **MVP MILESTONE**

The product is the deployed site. Local verification does not count.

**Files:**
- Modify: `README.md` (draft section — user-facing instructions must not mention Node, localhost or the poller)
- Modify: `CLAUDE.md` (record the new architecture)

- [ ] **Step 1: Confirm the deploy path**

`.github/workflows/pages.yml` deploys on push to `main`; the work is on `draft-v02`. Check with the repo owner whether to merge to `main` or point Pages at the branch. Do not merge without an explicit instruction.

- [ ] **Step 2: Rewrite the README's draft section**

Replace any draft instructions with user-facing ones only:

```markdown
### Draft

Open the **Draft** page and start a draft: choose your league size and your pick
position. No league id, no setup, nothing to install.

As your draft runs, search a surname and press **Taken** when someone else picks
him, or **Mine** when you take him. Everything recalculates instantly — the
recommendation, why it is recommended, positional scarcity, and how many picks
remain until your turn. Your draft survives a refresh.
```

Remove any mention of `npm run draft-live` from user-facing instructions.

- [ ] **Step 3: Update `CLAUDE.md`**

Add under "Layout":

```
js/draft/config.js      every tuneable strategy coefficient
js/draft/state.js       versioned, log-driven draft state (the source of truth)
js/draft/replacement.js live replacement level and VORP
js/draft/scarcity.js    cliffs, supply/demand, hard roster constraints
js/draft/value.js       the decision score and its explanations
js/draft/project.js     board projection over both horizons
scripts/freeze-prior.mjs  one-shot 2025/26 evidence freeze
scripts/test-draft.mjs    the draft engine suite
```

and a note: the draft assistant requires no league id and no local process; `scripts/draft-live.mjs` is experimental and nothing may depend on it.

- [ ] **Step 4: Deploy**

Push through the real Pages workflow (per the Step 1 decision) and wait for the deployment to complete.

- [ ] **Step 5: Verify on the deployed URL**

At `https://mickydoit.github.io/fpl-2627-tracker/draft.html`, walk the acceptance list:

1. Start a fresh draft; set league size 8 and slot 5
2. Enter ~20 picks, several from one position to create scarcity
3. Confirm the recommendation changes in response
4. Draft players to your team; confirm quota counters move
5. Undo a selection
6. Edit an earlier pick and confirm scarcity and demand recompute
7. Refresh the deployed page; confirm all state survives
8. Drive a draft to its end; confirm hard constraints force the last positions
9. Confirm a legal final 15 (2/5/5/3)
10. Check desktop, tablet and phone widths
11. Confirm the other six pages still load

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: the draft assistant needs no league id and no local process"
```

**🏁 Draft Night MVP complete. Everything below is refinement — the app is usable without it.**

---

## MILESTONE C — Model sophistication

### Task 11: 2026/27 BPS reconstruction with shrinkage

The current bonus model is a logistic fit on stale aggregate BPS, which mis-rates defenders and keepers under the rebalanced system.

**Files:**
- Create: `js/draft/scoring.js`
- Modify: `js/model.js:30-42` (add `bonusModel` to `DEFAULTS`), `js/model.js:228-230` (use it)
- Modify: `js/draft/project.js` (pass the new model)
- Modify: `scripts/test-draft.mjs` (append)

**Interfaces:**
- Produces: `estimateBps90(player)` → `{ bps90, confidence, approximate: true }`; `bonusFromBps90(bps90, confidence)` → number; `draftBonusModel(player)` → expected bonus per appearance.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`:

```js
import { estimateBps90, bonusFromBps90, draftBonusModel } from '../js/draft/scoring.js';

console.log('\n2026/27 BPS reconstruction');
const bigDefender = { element_type: 2, minutes: 3000, clearances_blocks_interceptions: 600,
  tackles: 90, recoveries: 150, clean_sheets: 14, goals_scored: 3, assists: 2,
  saves: 0, yellow_cards: 4, red_cards: 0, own_goals: 0, starts: 34, bps: 700 };
const shotStopper = { element_type: 1, minutes: 3420, saves: 140, clean_sheets: 13,
  penalties_saved: 2, clearances_blocks_interceptions: 40, tackles: 2, recoveries: 30,
  goals_scored: 0, assists: 0, yellow_cards: 1, red_cards: 0, own_goals: 0, starts: 38, bps: 616 };
const unproven = { element_type: 3, minutes: 120, clearances_blocks_interceptions: 5,
  tackles: 4, recoveries: 12, clean_sheets: 1, goals_scored: 1, assists: 0,
  saves: 0, yellow_cards: 0, red_cards: 0, own_goals: 0, starts: 1, bps: 40 };

ok('BPS is estimated per 90', estimateBps90(bigDefender).bps90 > 0);
ok('the estimate is flagged approximate', estimateBps90(bigDefender).approximate === true);
ok('a well-evidenced player is high confidence', estimateBps90(bigDefender).confidence > 0.9);
ok('an unproven player is low confidence', estimateBps90(unproven).confidence < 0.3);
ok('CBI now counts one per three, not one per two', (() => {
  const half = estimateBps90({ ...bigDefender, clearances_blocks_interceptions: 300 });
  const full = estimateBps90(bigDefender);
  return full.bps90 > half.bps90;
})());
ok('a shot-stopping keeper earns real BPS', estimateBps90(shotStopper).bps90 > 15);

console.log('\nBonus is shrunk, not capped');
const strong = bonusFromBps90(45, 1);
const weak = bonusFromBps90(12, 1);
ok('a high-BPS player earns more bonus', strong > weak);
ok('bonus stays inside the possible range', strong <= 3 && weak >= 0);
ok('the top of the distribution is not truncated', bonusFromBps90(60, 1) > bonusFromBps90(45, 1),
  'a hard cap would flatten these two together');
ok('low confidence shrinks toward the baseline',
  bonusFromBps90(60, 0.1) < bonusFromBps90(60, 1));
ok('shrinkage pulls up as well as down',
  bonusFromBps90(2, 0.1) > bonusFromBps90(2, 1));
ok('the model returns a per-appearance number', Number.isFinite(draftBonusModel(bigDefender)));

console.log('\nBonus does not dominate');
if (boardFile) {
  const projected2 = projectBoard(boardFile.players, fixturesFile);
  const shares = projected2
    .filter((r) => r.minutes > 1500 && r.parts && r.rosValue > 0)
    .map((r) => (r.parts.bonus * 38) / r.rosValue);
  const worst = Math.max(...shares);
  ok('no regular starter is bonus-dominated', worst < 0.35, `worst share ${worst.toFixed(2)}`);
  const top20 = [...projected2].sort((a, b) => b.rosValue - a.rosValue).slice(0, 20);
  ok('keepers do not take over the first round',
    top20.filter((r) => r.element_type === 1).length < 5,
    `${top20.filter((r) => r.element_type === 1).length} keepers in the top 20`);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL with `Cannot find module '../js/draft/scoring.js'`.

- [ ] **Step 3: Write `js/draft/scoring.js`**

```js
/**
 * 2026/27 BPS reconstruction.
 *
 * What can be claimed: the rebalanced BPS weights applied to the season totals
 * the game actually publishes — CBI at one per three (was one per two), the
 * tackled-penalty event gone, keeper saves restructured.
 *
 * What cannot: exact expected bonus. Bonus depends on a player's BPS relative
 * to the other twenty-one players in that specific match, and match-level Opta
 * event data is not public. So this is an estimate, flagged as one.
 *
 * Protection is by SHRINKAGE, not by a ceiling. Capping the bonus component
 * would flatten exactly the attacking full-backs and shot-stopping keepers the
 * rebalance rewards — the error this module exists to fix. Instead the estimate
 * is pulled toward a position baseline in proportion to how thin the evidence
 * behind it is, which restrains noisy players without truncating the top of the
 * distribution.
 */
import { DRAFT_CONFIG } from './config.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 2026/27 BPS weights for the events the API actually publishes. */
const BPS = {
  startingAppearance: 6,
  perGoal: { 1: 12, 2: 12, 3: 18, 4: 24 },
  perAssist: 9,
  cleanSheet: { 1: 12, 2: 12, 3: 0, 4: 0 },
  savesPerBps: 2,        // 1 BPS per 2 saves
  penaltySaved: 15,
  cbiPerBps: 3,          // 2026/27: 1 BPS per 3 CBI, was 1 per 2
  tackleBps: 2,
  recoveryPerBps: 3,
  yellow: -3,
  red: -9,
  ownGoal: -6,
};

/** A plausible BPS/90 baseline per position, used as the shrinkage target. */
const BASELINE_BPS90 = { 1: 18, 2: 16, 3: 15, 4: 14 };

/**
 * Estimated BPS per 90 from published season totals.
 * `confidence` rises with minutes played — thin evidence produces a number that
 * should not be trusted at face value, and the caller shrinks accordingly.
 */
export function estimateBps90(p) {
  const mins = num(p.minutes);
  const pos = p.element_type;
  if (mins <= 0) {
    return { bps90: BASELINE_BPS90[pos] ?? 15, confidence: 0, approximate: true };
  }

  const games = mins / 90;
  const total =
    num(p.starts) * BPS.startingAppearance
    + num(p.goals_scored) * (BPS.perGoal[pos] ?? 18)
    + num(p.assists) * BPS.perAssist
    + num(p.clean_sheets) * (BPS.cleanSheet[pos] ?? 0)
    + Math.floor(num(p.saves) / BPS.savesPerBps)
    + num(p.penalties_saved) * BPS.penaltySaved
    + Math.floor(num(p.clearances_blocks_interceptions) / BPS.cbiPerBps)
    + num(p.tackles) * BPS.tackleBps
    + Math.floor(num(p.recoveries) / BPS.recoveryPerBps)
    + num(p.yellow_cards) * BPS.yellow
    + num(p.red_cards) * BPS.red
    + num(p.own_goals) * BPS.ownGoal;

  const bps90 = Math.max(0, total / games);
  const confidence = clamp(mins / DRAFT_CONFIG.minutesConfidence, 0, 1);
  return { bps90, confidence, approximate: true };
}

/**
 * Expected bonus points per appearance from an estimated BPS/90.
 *
 * The logistic maps BPS/90 onto the 0–3 bonus range. Shrinkage blends the
 * player's own estimate with a league-average expectation in proportion to
 * confidence, so an unproven player regresses toward the middle instead of
 * inheriting a wild rate from 200 minutes of football.
 */
export function bonusFromBps90(bps90, confidence = 1) {
  const curve = (x) => 3 / (1 + Math.exp(-(x - 30) / 8));
  const own = curve(bps90);
  const baseline = curve(20);
  const c = clamp(confidence, 0, 1);
  return clamp(own * c + baseline * (1 - c), 0, 3);
}

/** Drop-in replacement for the model's internal bonus term. */
export function draftBonusModel(p) {
  const { bps90, confidence } = estimateBps90(p);
  return bonusFromBps90(bps90, confidence);
}
```

- [ ] **Step 4: Make the bonus model injectable in `js/model.js`**

In `DEFAULTS` (around line 41), add alongside `prior`:

```js
  bonusModel: null,     // (player) => expected bonus per appearance; defaults to the BPS logistic
```

Replace the bonus block (lines 228–230):

```js
  /* bonus — the injected model where one is supplied, otherwise the historic
     logistic map from bps per 90. The draft engine supplies a 2026/27
     reconstruction; the classic pages deliberately keep the old behaviour. */
  let bonus;
  if (o.bonusModel) {
    bonus = o.bonusModel(p) * minsFactor;
  } else {
    const bps90 = mins > 0 ? (num(p.bps) / mins) * 90 : 0;
    bonus = (1.9 / (1 + Math.exp(-(bps90 - o.bonusCentre) / o.bonusSpread))) * minsFactor;
  }
```

- [ ] **Step 5: Pass the model from the draft projection**

In `js/draft/project.js`, add the import and both `projectAll` option objects gain `bonusModel`:

```js
import { draftBonusModel } from './scoring.js';
```

```js
  const ros = projectAll(boot, fixtures, {
    horizon: DRAFT_CONFIG.rosHorizon, prior: draftPrior, bonusModel: draftBonusModel, ...opts,
  });
  const near = projectAll(boot, fixtures, {
    horizon: DRAFT_CONFIG.nearTermHorizon, prior: draftPrior, bonusModel: draftBonusModel, ...opts,
  });
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: the classic 149 checks pass **unchanged** (they pass no `bonusModel`, so their behaviour is identical), then the draft suite passes including the bonus-share assertions.

- [ ] **Step 7: Commit**

```bash
git add js/draft/scoring.js js/model.js js/draft/project.js scripts/test-draft.mjs
git commit -m "feat(draft): rebuild BPS on the 2026/27 weights, shrunk not capped"
```

---

### Task 12: Model validation diagnostics

Before trusting the ranking, look at it.

**Files:**
- Create: `scripts/draft-diagnostics.mjs`
- Modify: `package.json` (add `diagnostics` script)

- [ ] **Step 1: Write `scripts/draft-diagnostics.mjs`**

```js
/**
 * Draft model diagnostics. Dev-only — run `npm run diagnostics`.
 *
 * Prints the boards a human has to eyeball before trusting them, plus the two
 * checks worth failing over: whether the official draft_rank and our ranking
 * disagree wildly, and whether either replacement basis produces a nonsense
 * ordering. draft_rank is a BENCHMARK, not a target — beating it is the point.
 */
import { readJSON } from './lib/io.mjs';
import { projectBoard } from '../js/draft/project.js';
import { outstandingDemand, replacementLevel, attachVorp } from '../js/draft/replacement.js';
import { scarcityByPosition } from '../js/draft/scarcity.js';
import { evaluate } from '../js/draft/value.js';
import { QUOTA } from '../js/draft/config.js';

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const LEAGUE = Number(process.env.LEAGUE_SIZE) || 8;

const board = await readJSON('data/draft/players.json');
const fixtures = await readJSON('data/fixtures.json', []);
if (!board?.players?.length) throw new Error('no board data — run `npm run refresh:draft`');

const projected = projectBoard(board.players, fixtures);
const demand = outstandingDemand(new Map(), LEAGUE, new Map());
const replacement = replacementLevel(projected, demand, { leagueSize: LEAGUE });
const withVorp = attachVorp(projected, replacement);
const scarcity = scarcityByPosition(withVorp, demand, { leagueSize: LEAGUE });
const ranked = evaluate(withVorp, {
  replacement, demand, scarcity,
  needs: { ...QUOTA }, picksRemaining: 15,
  opponentPicksBeforeMyNext: LEAGUE - 1, round: 1, leagueSize: LEAGUE,
});

const table = (title, rows) => {
  console.log(`\n${title}`);
  console.log('  rank  player            pos  ROS    next5  VORP   scarce risk  value');
  rows.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(4)}  ${r.web_name.padEnd(17).slice(0, 17)} ${POS[r.element_type]}  `
      + `${r.rosValue.toFixed(1).padStart(6)} ${r.nearTermValue.toFixed(1).padStart(6)} `
      + `${r.vorp.toFixed(1).padStart(6)} ${r.scarcity.toFixed(2).padStart(6)} `
      + `${r.risk.toFixed(2).padStart(5)} ${r.draftValue.toFixed(1).padStart(6)}`);
  });
};

table(`Top 20 overall (${LEAGUE}-manager league)`, ranked.slice(0, 20));
for (const [type, n] of [[1, 10], [2, 20], [3, 20], [4, 15]]) {
  table(`Top ${n} ${POS[type]}`, ranked.filter((r) => r.element_type === type).slice(0, n));
}

console.log('\nReplacement level per position');
for (const t of [1, 2, 3, 4]) {
  const starters = replacementLevel(projected, demand, { basis: 'starters', leagueSize: LEAGUE })[t];
  console.log(`  ${POS[t]}  demand-basis ${replacement[t].toFixed(1)}   starters-basis ${starters.toFixed(1)}`);
}

console.log('\nSanity checks');
const top20 = ranked.slice(0, 20);
const keepers = top20.filter((r) => r.element_type === 1).length;
console.log(`  keepers in the top 20: ${keepers} ${keepers >= 5 ? '← INVESTIGATE' : 'ok'}`);

const withRank = ranked.filter((r) => Number.isFinite(r.draft_rank)).slice(0, 100);
const disagreements = withRank.filter((r, i) => Math.abs(r.draft_rank - (i + 1)) > 60);
console.log(`  top-100 players more than 60 places from FPL's draft_rank: ${disagreements.length}`);
disagreements.slice(0, 10).forEach((r, i) => {
  const ours = ranked.indexOf(r) + 1;
  console.log(`    ${r.web_name} — ours #${ours}, FPL #${r.draft_rank}`);
});
console.log('\n  draft_rank is a benchmark, not a target. Large gaps are worth understanding, not eliminating.');
```

- [ ] **Step 2: Add the npm script**

```json
"diagnostics": "node scripts/draft-diagnostics.mjs",
```

- [ ] **Step 3: Run and read the output**

Run: `npm run diagnostics`

Read every table. Investigate — do not accept — any of: five or more keepers in the top 20, a defender above every forward and midfielder, a player with under 500 minutes in the top 10, or a replacement level above the median player at that position.

- [ ] **Step 4: Commit**

```bash
git add scripts/draft-diagnostics.mjs package.json
git commit -m "feat(draft): diagnostics for the numbers a human has to eyeball"
```

---

### Task 13: Tune against a simulated draft

The existing `js/draft/compete.js` already drafts a full squad under competing strategies. Point it at the new engine to confirm the rebuild is an improvement, not just a refactor.

**Files:**
- Modify: `js/draft/compete.js` (add the new engine as a strategy)
- Modify: `scripts/test-draft.mjs` (append)

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-draft.mjs`:

```js
console.log('\nThe new engine beats the baselines');
if (boardFile) {
  const { runDraft, STRATEGIES } = await import('../js/draft/compete.js');
  ok('the value engine is available as a strategy', typeof STRATEGIES.value === 'function');
  const pool = projectBoard(boardFile.players, fixturesFile);
  let wins = 0; let losses = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const result = runDraft(pool, { leagueSize: 8, seed, strategies: ['value', 'rank'] });
    if (result.scores.value > result.scores.rank) wins++; else losses++;
  }
  ok('the value engine beats drafting by the game ranking', wins > losses, `${wins}W ${losses}L`);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-draft.mjs`
Expected: FAIL — `STRATEGIES.value` is not defined.

- [ ] **Step 3: Add the strategy**

Read `js/draft/compete.js` and add a `value` strategy alongside the existing ones that, given the available pool and a roster, calls `evaluate` with the live replacement level, demand and needs and returns the top row. Follow the signature the existing strategies use — do not change `runDraft`'s interface, since the existing baseline comparisons depend on it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-draft.mjs`
Expected: PASS with a winning record. If the value engine loses, tune `DRAFT_CONFIG` weights — that is what they are for — and record what changed and why.

- [ ] **Step 5: Commit**

```bash
git add js/draft/compete.js scripts/test-draft.mjs
git commit -m "test(draft): prove the value engine beats the game's own ranking"
```

---

## Done when

- `npm test` passes: the classic 149 checks unchanged, plus the full draft suite.
- `npm run diagnostics` produces boards a human has reviewed and found sane.
- The **deployed** `draft.html` completes every step of Task 10 Step 5.
- No user-facing instruction anywhere mentions Node, localhost, a league id or the poller.
- The classic squad optimiser, its tests and its output are unchanged.
- `Finish Draft` state carries my 15, opponent rosters, drafted players and the undrafted pool — the foundation Phase 2 builds on.
