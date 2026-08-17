/**
 * Draft engine checks. Run with `node scripts/test-draft.mjs`.
 * Kept separate from scripts/test.mjs so the classic model and optimiser
 * suite stays untouched and its regression guarantee stays legible.
 */
import { readJSON } from './lib/io.mjs';
import { DRAFT_CONFIG, QUOTA, STARTER_QUOTA, ROUNDS,
  LEAGUE_SIZE_DEFAULT, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX } from '../js/draft/config.js';
import {
  SCHEMA_VERSION, createDraft, addPick, undoLastPick, editPick, derive, needsFor,
  slotForPick, roundForPick, finishDraft, finalPools, save, load, clear, migrateLegacy,
} from '../js/draft/state.js';

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
const TYPES = new Map([[101, 2], [102, 3], [103, 3], [104, 4], [105, 3], [999, 2]]);
ok('a fresh draft needs the full quota',
  JSON.stringify(needsFor([], TYPES)) === JSON.stringify({ 1: 2, 2: 5, 3: 5, 4: 3 }));
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
  Object.values(needsFor(derive(s).myRoster, TYPES)).reduce((a, b) => a + b, 0) === 13);

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

console.log('\nDraft state — derive() needs with types supplied');
// needsFor() alone was covered above, but derive(s, TYPES).needs — the field
// Task 9's recommendation engine reads — was never exercised or asserted.
let needsState = createDraft({ leagueSize: 8, mySlot: 1 });
const NEEDS_TYPES = new Map([[301, 1], [302, 2], [303, 2], [304, 2], [305, 2], [306, 2]]);
ok('derive() starts at the full quota once types are supplied',
  JSON.stringify(derive(needsState, NEEDS_TYPES).needs) === JSON.stringify(QUOTA));

needsState = addPick(needsState, { elementId: 301, mine: true }); // a keeper
ok('drafting a keeper decrements only the GK need',
  derive(needsState, NEEDS_TYPES).needs[1] === 1 && derive(needsState, NEEDS_TYPES).needs[2] === 5);

[302, 303, 304, 305, 306].forEach((id) => { // five defenders
  needsState = addPick(needsState, { elementId: id, mine: true });
});
ok('needs keeps decrementing as each defender is drafted', derive(needsState, NEEDS_TYPES).needs[2] === 0);
ok('a filled position reports zero, not negative',
  Object.values(derive(needsState, NEEDS_TYPES).needs).every((n) => n >= 0));
ok('an untouched position still reports its full quota', derive(needsState, NEEDS_TYPES).needs[3] === 5);

console.log('\nDraft state — persistence');
// Node has no localStorage. state.js only touches it inside function bodies,
// so a minimal in-memory shim installed before these calls is enough to
// exercise the real save/load/clear/migrateLegacy code paths.
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

const STORAGE_KEY = 'draftState.v1';
let toPersist = createDraft({ leagueSize: 6, mySlot: 3 });
toPersist = addPick(toPersist, { elementId: 501, mine: true });
toPersist = addPick(toPersist, { elementId: 502, mine: false });
save(toPersist);
const reloaded = load();
ok('a saved draft reloads identically', JSON.stringify(reloaded) === JSON.stringify(toPersist));

localStorage.setItem(STORAGE_KEY, '{not valid json');
ok('load() returns null for a corrupt payload', load() === null);

localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...toPersist, version: 999 }));
ok('load() returns null for a wrong schema version', load() === null);

save(toPersist);
clear();
ok('clear() removes the saved draft', load() === null);

localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...toPersist, mySlot: 999 }));
ok('load() clamps a mySlot above range down to the league size',
  load().mySlot === toPersist.leagueSize);

const noSlot = { ...toPersist };
delete noSlot.mySlot;
localStorage.setItem(STORAGE_KEY, JSON.stringify(noSlot));
ok('load() defaults a missing mySlot to slot one', load().mySlot === 1);

localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...toPersist, mySlot: 0 }));
ok('load() clamps a zero mySlot up to slot one', load().mySlot === 1);

localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...toPersist, mySlot: -5 }));
ok('load() clamps a negative mySlot up to slot one', load().mySlot === 1);

localStorage.setItem('draftTaken', JSON.stringify([1, 2, 3]));
localStorage.setItem('draftEntry', JSON.stringify({}));
ok('migrateLegacy finds and removes the old keys', migrateLegacy() === true);
ok('migrateLegacy leaves no trace of the legacy keys',
  localStorage.getItem('draftTaken') === null && localStorage.getItem('draftEntry') === null);
ok('migrateLegacy reports false once there is nothing left to migrate', migrateLegacy() === false);

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} draft checks passed`);
process.exit(failures ? 1 : 0);
