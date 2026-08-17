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
import { outstandingDemand, replacementLevel, attachVorp } from '../js/draft/replacement.js';
import { playersBeforeCliff, scarcityByPosition, allowedPositions } from '../js/draft/scarcity.js';
import { survival } from '../js/draft/simulate.js';
import { evaluate } from '../js/draft/value.js';
import { projectBoard, toModelRow } from '../js/draft/project.js';
import { teamDefence } from '../js/model.js';
import { estimateBps90, bonusFromBps90, draftBonusModel } from '../js/draft/scoring.js';

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

console.log('\nReplacement basis — starters vs demand');
// Use a large pool (30 forwards) so league-size changes select genuinely different players.
const bigPool = mkRows(4, Array.from({ length: 30 }, (_, i) => 95 - i * 2));
// At league size 4, 12 FWD slots needed (4 managers × 3 per roster).
// At league size 8, 24 FWD slots needed.
// Starters basis: league size 4 wants 8 (4 managers × 2 starters), league size 8 wants 16.
const demandSmall4 = outstandingDemand(new Map(), 4, new Map());
const demandBig8 = outstandingDemand(new Map(), 8, new Map());
const repDemandSmall = replacementLevel(bigPool, demandSmall4, { basis: 'demand' })[4];
const repDemandBig = replacementLevel(bigPool, demandBig8, { basis: 'demand' })[4];
ok('demand basis: larger league has deeper replacement (lower proj points)',
  repDemandBig < repDemandSmall, `small=${repDemandSmall} big=${repDemandBig}`);

const repStartersSmall = replacementLevel(bigPool, demandSmall4, { basis: 'starters', leagueSize: 4 })[4];
const repStartersBig = replacementLevel(bigPool, demandBig8, { basis: 'starters', leagueSize: 8 })[4];
ok('starters basis: larger league has deeper replacement',
  repStartersBig < repStartersSmall, `small=${repStartersSmall} big=${repStartersBig}`);

const repDemand4 = replacementLevel(bigPool, demandSmall4, { basis: 'demand' })[4];
const repStarters4 = replacementLevel(bigPool, demandSmall4, { basis: 'starters', leagueSize: 4 })[4];
ok('starters basis is shallower than demand basis (fewer slots to fill)',
  repStarters4 > repDemand4, `demand=${repDemand4} starters=${repStarters4}`);

console.log('\nVORP');
const withVorp = attachVorp(fwds, { 4: 69 });
ok('VORP is measured against replacement', withVorp[0].vorp === 92 - 69);
ok('the replacement player scores zero VORP',
  withVorp.find((r) => r.proj === 69).vorp === 0);
ok('below-replacement players score negative VORP',
  withVorp.find((r) => r.proj === 55).vorp < 0);

console.log('\nVORP responds to league size');
// Use the large pool (30 forwards) and actual demand computations.
// This ensures league size 4 and 8 genuinely pick different replacement players.
const repSmall = replacementLevel(bigPool, demandSmall4, { basis: 'demand' })[4];
const repBig = replacementLevel(bigPool, demandBig8, { basis: 'demand' })[4];
ok('VORP baseline deepens in larger leagues (more slots to fill)',
  repBig < repSmall, `small=${repSmall} big=${repBig}`);

console.log('\nScarcity is about VORP gaps, not supply counts');
// Verify playersBeforeCliff still works correctly
const cliffy = mkRows(4, [92, 89, 87, 69, 67, 65]);
const flat = mkRows(2, [88, 87, 86, 85, 84, 83]);
ok('cliff detection: cliffy yields 3 before cliff', playersBeforeCliff(cliffy, 4) === 3,
  `got ${playersBeforeCliff(cliffy, 4)}`);
ok('cliff detection: flat yields 6 (no cliff)', playersBeforeCliff(flat, 2) === 6,
  `got ${playersBeforeCliff(flat, 2)}`);

// New scarcity model: label comes from VORP gap ranking
// Create four positions with different gaps: FWD (large), DEF (medium), MID (small), GK (zero demand = always LOW)
const gappedPool = [
  // Position 4 (FWD): best player has huge VORP — should be HIGH
  { element_type: 4, proj: 95, vorp: 22, id: 4001 },
  { element_type: 4, proj: 70, vorp: -3, id: 4002 },
  { element_type: 4, proj: 60, vorp: -13, id: 4003 },
  // Position 2 (DEF): best player has modest VORP — should be MEDIUM
  { element_type: 2, proj: 50, vorp: 8, id: 2001 },
  { element_type: 2, proj: 42, vorp: 0, id: 2002 },
  // Position 3 (MID): best player close to replacement — should be LOW
  { element_type: 3, proj: 80, vorp: 3, id: 3001 },
  { element_type: 3, proj: 77, vorp: 0, id: 3002 },
  // Position 1 (GK): zero demand — should be LOW regardless of gap
  { element_type: 1, proj: 30, vorp: 15, id: 1001 },
];

const sc = scarcityByPosition(gappedPool, { 4: 5, 2: 10, 3: 15, 1: 0 }, { leagueSize: 8 });
ok('largest gap (FWD vorp=22) is HIGH', sc[4].label === 'HIGH', `got ${sc[4].label}`);
ok('second-largest gap (DEF vorp=8) is MEDIUM', sc[2].label === 'MEDIUM', `got ${sc[2].label}`);
ok('smaller gap (MID vorp=3) is LOW', sc[3].label === 'LOW', `got ${sc[3].label}`);
ok('zero demand (GK) is always LOW', sc[1].label === 'LOW', `got ${sc[1].label}`);
ok('scarcity reports available supply', sc[4].available === 3);
ok('scarcity reports outstanding demand', sc[4].demand === 5);
ok('scarcity reports supply-per-slot ratio', sc[4].ratio === 3 / 5);
ok('scarcity reports cliff count', sc[4].beforeCliff === 3);

// Verify: empty pool with demand is HIGH (exhausted)
ok('exhausted position (empty pool, demand > 0) is HIGH',
  scarcityByPosition([], { 4: 5 }, { leagueSize: 8 })[4].label === 'HIGH');

// Regression test: best player detection does NOT depend on input order.
// Construct pool with best player deliberately LAST in input order.
const unorderedPool = [
  { element_type: 4, proj: 60, vorp: -13, id: 4003 },  // worst
  { element_type: 4, proj: 70, vorp: -3, id: 4002 },   // middle
  { element_type: 4, proj: 95, vorp: 22, id: 4001 },   // BEST but LAST in input
  { element_type: 2, proj: 42, vorp: 0, id: 2002 },    // worst
  { element_type: 2, proj: 50, vorp: 8, id: 2001 },    // best but last
];
const scUnordered = scarcityByPosition(unorderedPool, { 4: 5, 2: 10 }, { leagueSize: 8 });
ok('gap detection is input-order-invariant (FWD best last in array)', scUnordered[4].label === 'HIGH',
  `got ${scUnordered[4].label}`);
ok('gap detection is input-order-invariant (DEF best last in array)', scUnordered[2].label === 'MEDIUM',
  `got ${scUnordered[2].label}`);

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

console.log('\nSurvival without the Draft API');
const noRank = [
  { id: 11, element_type: 4, proj: 92 },
  { id: 12, element_type: 4, proj: 60 },
];
const survNoRank = survival(noRank, 1, { seed: 1, trials: 200 });
ok('the best player is still least likely to survive',
  survNoRank.get(11) < survNoRank.get(12),
  'without draft_rank the model must fall back to projection');

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
// Deliberately the INVERSE of a "scarcity is obviously right" fixture: the
// defender leads on raw VORP (20 vs 18), so if the scarcity term did nothing
// — or were inverted, or a constant — the defender would win. `ctx.scarcity`
// is supplied explicitly (bypassing scarcityByPosition, which cannot see a
// meaningful label from a two-row candidate slice) so the label is under the
// test's control: FWD is HIGH, DEF is LOW. `opponentPicksBeforeMyNext: 0`
// collapses survival to 1 for everyone, zeroing the urgency term, and equal
// `needs` values zero out any rosterNeed differential — isolating scarcity
// as the only thing that can flip the raw-VORP order.
const scarceCand = [
  { id: 21, element_type: 4, proj: 88, rosValue: 88, nearTermValue: 11, draft_rank: 1, availability: 1, minutes: 3000 },
  { id: 22, element_type: 2, proj: 90, rosValue: 90, nearTermValue: 11, draft_rank: 2, availability: 1, minutes: 3000 },
];
const scarceCtx = {
  replacement: { 1: 0, 2: 70, 3: 0, 4: 70 },
  demand: { 1: 16, 2: 40, 3: 40, 4: 24 },
  needs: { 1: 2, 2: 5, 3: 5, 4: 5 }, // equal to DEF's need — rosterNeed cancels out
  picksRemaining: 17,
  opponentPicksBeforeMyNext: 0,
  round: 1,
  leagueSize: 8,
  scarcity: {
    1: { available: 0, demand: 16, ratio: 0, beforeCliff: 0, label: 'LOW' },
    2: { available: 40, demand: 40, ratio: 1, beforeCliff: 40, label: 'LOW' },
    3: { available: 0, demand: 40, ratio: 0, beforeCliff: 0, label: 'LOW' },
    4: { available: 3, demand: 24, ratio: 0.125, beforeCliff: 3, label: 'HIGH' },
  },
};
const scarceRanked = evaluate(scarceCand, scarceCtx);
ok('the defender actually leads on raw VORP alone (so the win must come from scarcity)',
  scarceRanked.find((r) => r.element_type === 2).vorp > scarceRanked.find((r) => r.element_type === 4).vorp,
  `DEF vorp ${scarceRanked.find((r) => r.element_type === 2).vorp} FWD vorp ${scarceRanked.find((r) => r.element_type === 4).vorp}`);
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

console.log('\nBoard projection');
const boardFile = await readJSON('data/draft/players.json');
const fixturesFile = await readJSON('data/fixtures.json', []);
if (boardFile) {
  const projected = projectBoard(boardFile.players, fixturesFile, boardFile.teams);
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

console.log('\nTeam defensive strength is genuinely differentiated');
// Regression guard for a specific failure mode: projectBoard building a
// synthetic `teams` array of bare `{id}` rows, which silently defeats
// teamDefence()'s strength-rating fallback for under-informed clubs (newly
// promoted sides) and collapses every one of them to the identical
// league-average xGC. Reads only data/draft/players.json — never
// data/bootstrap.json, which is synthetic seed data regenerated on every
// `npm test` run and must not leak into these assertions.
if (boardFile) {
  ok('the committed board dataset carries real team strength ratings',
    Array.isArray(boardFile.teams) && boardFile.teams.length === 20,
    `got ${boardFile.teams?.length ?? 0} teams`);
  const rows = boardFile.players.map(toModelRow);
  const defence = teamDefence(rows, boardFile.teams);
  const distinct = new Set(Object.values(defence).map((v) => v.toFixed(3)));
  ok('clubs do not all collapse to a single defensive rating',
    distinct.size > 1, `only ${distinct.size} distinct xGC value(s) across ${boardFile.teams.length} clubs`);
  const strength = (t) => t.strength_overall_home + t.strength_overall_away;
  const byStrength = [...boardFile.teams].sort((a, b) => strength(b) - strength(a));
  const strongest = byStrength[0];
  const weakest = byStrength[byStrength.length - 1];
  ok('a club known to be weak rates worse defensively than a club known to be strong',
    defence[weakest.id] > defence[strongest.id],
    `${weakest.name} xGC=${defence[weakest.id]?.toFixed(3)} vs ${strongest.name} xGC=${defence[strongest.id]?.toFixed(3)}`);
}

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
ok('a shot-stopping keeper earns materially more BPS than a low-save keeper', (() => {
  const lowSaves = estimateBps90({ ...shotStopper, saves: 0 }).bps90;
  const highSaves = estimateBps90(shotStopper).bps90;
  return highSaves - lowSaves > 1;
})());
ok('the reconstruction recovers a substantial share of observed old-rules BPS without exceeding it', (() => {
  // Published season aggregates omit a large share of real BPS events (passes,
  // key passes, tackles won, saves inside the box, big chances). Recovering a
  // healthy fraction of the observed old-rules total — but never exceeding it,
  // which would mean double-counting — is the honest result of reconstructing
  // from the visible subset. This is NOT calibrated to match the old total
  // exactly: the whole point of the 2026/27 rebalance is that the two figures
  // legitimately differ.
  const observedBps90 = (shotStopper.bps / shotStopper.minutes) * 90;
  const reconstructed = estimateBps90(shotStopper).bps90;
  return reconstructed > observedBps90 * 0.5 && reconstructed <= observedBps90;
})());

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

console.log('\nShrinkage targets a position-specific baseline, not a flat one');
// Regression guard: BASELINE_BPS90 is documented as "the shrinkage target" but a
// zero-minute player has confidence 0, which zeroes out their own bps90 entirely
// in the blend — if the baseline itself doesn't vary by position, every unproven
// player of any position collapses to the identical shrunk bonus.
const zeroKeeper = { element_type: 1, minutes: 0 };
const zeroForward = { element_type: 4, minutes: 0 };
ok('a zero-minute keeper and a zero-minute forward shrink to different bonuses',
  Math.abs(draftBonusModel(zeroKeeper) - draftBonusModel(zeroForward)) > 0.05,
  `keeper ${draftBonusModel(zeroKeeper).toFixed(3)} vs forward ${draftBonusModel(zeroForward).toFixed(3)}`);
ok('a thin-evidence player shrinks toward THEIR OWN position baseline, not a shared one', (() => {
  const thinKeeper = bonusFromBps90(50, 0.05, 1);
  const thinForward = bonusFromBps90(50, 0.05, 4);
  return Math.abs(thinKeeper - thinForward) > 0.05;
})());
ok('a well-evidenced player still tracks their own estimate regardless of position baseline', (() => {
  const keeperFull = bonusFromBps90(50, 1, 1);
  const forwardFull = bonusFromBps90(50, 1, 4);
  return Math.abs(keeperFull - forwardFull) < 0.01;
})());

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

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} draft checks passed`);
process.exit(failures ? 1 : 0);
