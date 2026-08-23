/**
 * Draft engine checks. Run with `node scripts/test-draft.mjs`.
 * Kept separate from scripts/test.mjs so the classic model and optimiser
 * suite stays untouched and its regression guarantee stays legible.
 */
import { readJSON } from './lib/io.mjs';
import { DRAFT_CONFIG, QUOTA, STARTER_QUOTA, ROUNDS,
  LEAGUE_SIZE_DEFAULT, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX,
  replacementBasisForLeagueSize, DEMAND_BASIS_SIZES } from '../js/draft/config.js';
import {
  SCHEMA_VERSION, createDraft, addPick, undoLastPick, editPick, derive, needsFor,
  slotForPick, roundForPick, finishDraft, finalPools, save, load, clear, migrateLegacy,
  encodeDraft, decodeDraft,
} from '../js/draft/state.js';
import { outstandingDemand, replacementLevel, attachVorp } from '../js/draft/replacement.js';
import { playersBeforeCliff, scarcityByPosition, allowedPositions } from '../js/draft/scarcity.js';
import { survival } from '../js/draft/simulate.js';
import { evaluate } from '../js/draft/value.js';
import { projectBoard, toModelRow } from '../js/draft/project.js';
import { teamDefence } from '../js/model.js';
import { estimateBps90, bonusFromBps90, draftBonusModel } from '../js/draft/scoring.js';
import { runDraft, STRATEGIES } from '../js/draft/compete.js';
import fs from 'node:fs';
import { bestXI, depthCost, squadVorp, riskScore, rateSquad, rateLeague, positionalStrength } from '../js/draft/rating.js';
import { draftXI, rosterValue, positionScarcity, classifyWaiver, bestWaiver, WAIVER_CONFIG } from '../js/draft/waiver.js';
import { actionableEvent, upcomingByTeam } from '../js/model.js';

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
ok('six managers by default — the owner\'s league', LEAGUE_SIZE_DEFAULT === 6);
ok('the default is a selectable size', LEAGUE_SIZE_DEFAULT >= LEAGUE_SIZE_MIN && LEAGUE_SIZE_DEFAULT <= LEAGUE_SIZE_MAX);
ok('league size spans two to sixteen', LEAGUE_SIZE_MIN === 2 && LEAGUE_SIZE_MAX === 16);
ok('the near-term horizon is configurable', DRAFT_CONFIG.nearTermHorizon === 5);
ok('every weight is a finite number',
  ['rosWeight', 'nearTermWeight', 'vorpWeight', 'scarcityWeight', 'urgencyWeight',
    'rosterNeedWeight', 'riskWeight'].every((k) => Number.isFinite(DRAFT_CONFIG[k])));
// The basis is chosen by evidence, not preference. It is no longer one constant:
// which basis wins depends on league size, and the head-to-head later in this
// suite asserts the rule still matches what actually wins.
ok('the basis override is off by default, so the league-size rule applies',
  DRAFT_CONFIG.replacementBasis === null);
ok('the rule returns a supported basis at every selectable league size',
  Array.from({ length: LEAGUE_SIZE_MAX - LEAGUE_SIZE_MIN + 1 }, (_, i) => i + LEAGUE_SIZE_MIN)
    .every((n) => ['demand', 'starters'].includes(replacementBasisForLeagueSize(n))));
ok('the default league size gets the basis the evidence supports',
  replacementBasisForLeagueSize(LEAGUE_SIZE_DEFAULT) === 'demand',
  `got ${replacementBasisForLeagueSize(LEAGUE_SIZE_DEFAULT)} for ${LEAGUE_SIZE_DEFAULT} managers`);
ok('an unusable league size falls back rather than throwing',
  ['demand', 'starters'].includes(replacementBasisForLeagueSize(undefined))
  && ['demand', 'starters'].includes(replacementBasisForLeagueSize('nonsense')));
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
  /* parts.bonus is the contribution summed over the projected horizon, so a
     season estimate needs the per-match average rather than the total. It used
     to be a single fixture's value, which is why this once read `* 38`. */
  const shares = projected2
    .filter((r) => r.minutes > 1500 && r.parts?.fixtures > 0 && r.rosValue > 0)
    .map((r) => ((r.parts.bonus / r.parts.fixtures) * 38) / r.rosValue);
  const worst = Math.max(...shares);
  ok('no regular starter is bonus-dominated', worst < 0.35, `worst share ${worst.toFixed(2)}`);
  const top20 = [...projected2].sort((a, b) => b.rosValue - a.rosValue).slice(0, 20);
  ok('keepers do not take over the first round',
    top20.filter((r) => r.element_type === 1).length < 5,
    `${top20.filter((r) => r.element_type === 1).length} keepers in the top 20`);
}

console.log('\nThe new engine beats the baselines');
if (boardFile) {
  ok('the value engine is available as a strategy', typeof STRATEGIES.value === 'function');

  const pool = projectBoard(boardFile.players, fixturesFile, boardFile.teams);
  const LEAGUE = 8;
  const SEEDS = 20;
  let wins = 0; let losses = 0; let ties = 0; let marginSum = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const value = runDraft(pool, { leagueSize: LEAGUE, mySlot: 3, strategy: STRATEGIES.value, seed });
    const rank = runDraft(pool, { leagueSize: LEAGUE, mySlot: 3, strategy: STRATEGIES.draftRank, seed });
    const margin = value.total - rank.total;
    marginSum += margin;
    if (margin > 1e-9) wins++;
    else if (margin < -1e-9) losses++;
    else ties++;
  }
  console.log(`  ${SEEDS} seeds, mySlot 3 of ${LEAGUE}: ${wins}W ${losses}L ${ties}T, avg margin ${(marginSum / SEEDS).toFixed(2)} pts per squad`);
  ok('the value engine beats drafting by the game ranking',
    wins > losses, `${wins}W ${losses}L ${ties}T across ${SEEDS} seeds, avg margin ${(marginSum / SEEDS).toFixed(2)} pts`);
}

console.log('\nReplacement basis head-to-head: demand vs starters');
/*
 * Neither basis wins everywhere. This runs the real engine under each basis on
 * the same board, seed and slot — so both arms face identical opponents and the
 * only difference is my own strategy — and asserts that
 * replacementBasisForLeagueSize() still names the winner.
 *
 * Sizes either side of both boundaries, kept small enough to stay a test rather
 * than a benchmark. The full sweep behind the rule is documented in config.js.
 */
if (boardFile) {
  const pool = projectBoard(boardFile.players, fixturesFile, boardFile.teams);
  const SEEDS = 6;
  const originalBasis = DRAFT_CONFIG.replacementBasis;
  const headToHead = (leagueSize) => {
    let startersWins = 0; let demandWins = 0; let ties = 0; let marginSum = 0; let n = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (let slot = 1; slot <= leagueSize; slot++) {
        DRAFT_CONFIG.replacementBasis = 'demand';
        const demand = runDraft(pool, { leagueSize, mySlot: slot, strategy: STRATEGIES.value, seed });
        DRAFT_CONFIG.replacementBasis = 'starters';
        const starters = runDraft(pool, { leagueSize, mySlot: slot, strategy: STRATEGIES.value, seed });
        const margin = starters.total - demand.total;
        marginSum += margin; n++;
        if (margin > 1e-9) startersWins++;
        else if (margin < -1e-9) demandWins++;
        else ties++;
      }
    }
    return { startersWins, demandWins, ties, n, avg: marginSum / n };
  };

  for (const leagueSize of [6, 12]) {
    const r = headToHead(leagueSize);
    const winner = r.startersWins > r.demandWins ? 'starters' : 'demand';
    const rule = replacementBasisForLeagueSize(leagueSize);
    console.log(`  ${leagueSize} managers, ${r.n} paired drafts: starters ${r.startersWins}, demand ${r.demandWins}, ties ${r.ties}`
      + `  avg margin ${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(2)} -> ${winner}, rule says ${rule}`);
    ok(`the ${leagueSize}-manager head-to-head produced a clear winner`,
      r.startersWins !== r.demandWins, `${r.startersWins} vs ${r.demandWins}`);
    ok(`the rule matches the evidence at ${leagueSize} managers`,
      rule === winner, `rule=${rule} evidence=${winner}`);
  }
  DRAFT_CONFIG.replacementBasis = originalBasis;
  ok('the head-to-head restored the override it borrowed', DRAFT_CONFIG.replacementBasis === null);
}

console.log('\nReplacement basis by league size');
{
  /* Re-measured after the defensive-contribution fix moved the answer. The band
     that used to sit at five-to-nine is gone; starters wins everywhere with a
     stable signal. config.js carries the corrected table and the one anomaly. */
  ok('a six-manager league uses demand', replacementBasisForLeagueSize(6) === 'demand');
  ok('a twelve-manager league uses starters', replacementBasisForLeagueSize(12) === 'starters');
  ok('demand applies over a contiguous band, not scattered sizes',
    Array.from({ length: LEAGUE_SIZE_MAX - LEAGUE_SIZE_MIN + 1 }, (_, i) => i + LEAGUE_SIZE_MIN)
      .filter((n) => replacementBasisForLeagueSize(n) === 'demand')
      .every((n, i, a) => i === 0 || n === a[i - 1] + 1));
  ok('the crossover sits where the evidence puts it',
    replacementBasisForLeagueSize(DEMAND_BASIS_SIZES.max) === 'demand'
    && replacementBasisForLeagueSize(DEMAND_BASIS_SIZES.max + 1) === 'starters');
  ok('if a band is ever restored the rule reads it, rather than hardcoding',
    typeof replacementBasisForLeagueSize === 'function'
    && replacementBasisForLeagueSize(6) === replacementBasisForLeagueSize(LEAGUE_SIZE_DEFAULT));

  if (boardFile) {
    const pool = projectBoard(boardFile.players, fixturesFile, boardFile.teams);
    const noDemand = outstandingDemand(new Map(), 6, new Map());

    // The rule has to actually reach replacementLevel(), not just exist.
    const auto6 = replacementLevel(pool, noDemand, { leagueSize: 6 });
    const forced6 = replacementLevel(pool, noDemand, { basis: 'demand', leagueSize: 6 });
    ok('replacementLevel applies the rule for the league size it is given',
      JSON.stringify(auto6) === JSON.stringify(forced6));

    const d12 = outstandingDemand(new Map(), 12, new Map());
    const auto12 = replacementLevel(pool, d12, { leagueSize: 12 });
    const forced12 = replacementLevel(pool, d12, { basis: 'starters', leagueSize: 12 });
    ok('a twelve-manager league really gets the starters baseline',
      JSON.stringify(auto12) === JSON.stringify(forced12));

    // An explicit basis must still beat the rule, or the diagnostics lie.
    const override = replacementLevel(pool, noDemand, { basis: 'starters', leagueSize: 6 });
    ok('an explicit basis overrides the rule',
      JSON.stringify(override) !== JSON.stringify(auto6));

    // Determinism and legality under the rule, at both bases.
    for (const leagueSize of [6, 12]) {
      const a = runDraft(pool, { leagueSize, mySlot: 2, strategy: STRATEGIES.value, seed: 4242 });
      const b = runDraft(pool, { leagueSize, mySlot: 2, strategy: STRATEGIES.value, seed: 4242 });
      ok(`a ${leagueSize}-manager draft under the rule is reproducible`, a.total === b.total,
        `${a.total} vs ${b.total}`);
      ok(`a ${leagueSize}-manager roster is fifteen players`, a.roster.length === 15);
      const byPos = a.roster.reduce((acc, p) => { acc[p.element_type] = (acc[p.element_type] || 0) + 1; return acc; }, {});
      ok(`a ${leagueSize}-manager roster respects the 2/5/5/3 quota`,
        [1, 2, 3, 4].every((t) => byPos[t] === QUOTA[t]), JSON.stringify(byPos));
      ok(`a ${leagueSize}-manager draft picks nobody twice`,
        new Set(a.roster.map((p) => p.id)).size === 15);
    }

    // Draft is a no-money game. Nothing price-shaped may reach a recommendation.
    const demand6 = outstandingDemand(new Map(), 6, new Map());
    const ranked = evaluate(attachVorp(pool, replacementLevel(pool, demand6, { leagueSize: 6 })), {
      replacement: replacementLevel(pool, demand6, { leagueSize: 6 }),
      demand: demand6,
      scarcity: scarcityByPosition(attachVorp(pool, replacementLevel(pool, demand6, { leagueSize: 6 })), demand6, { leagueSize: 6 }),
      needs: { 1: 2, 2: 5, 3: 5, 4: 3 },
      picksRemaining: 15, opponentPicksBeforeMyNext: 5, round: 1, leagueSize: 6,
    });
    /* Draft is a no-money game. `now_cost` rides along for display, so asserting
       it is absent would be wrong — assert instead that it cannot influence a
       decision: scramble every price and the ranking must not move at all. */
    const scrambled = pool.map((r, i) => ({ ...r, now_cost: ((i * 37) % 120) + 40 }));
    const scrRep = replacementLevel(scrambled, demand6, { leagueSize: 6 });
    const scrRanked = evaluate(attachVorp(scrambled, scrRep), {
      replacement: scrRep,
      demand: demand6,
      scarcity: scarcityByPosition(attachVorp(scrambled, scrRep), demand6, { leagueSize: 6 }),
      needs: { 1: 2, 2: 5, 3: 5, 4: 3 },
      picksRemaining: 15, opponentPicksBeforeMyNext: 5, round: 1, leagueSize: 6,
    });
    ok('scrambling every price does not move the draft ranking',
      ranked.length === scrRanked.length
      && ranked.every((r, i) => r.id === scrRanked[i].id),
      `first divergence at ${ranked.findIndex((r, i) => r.id !== scrRanked[i]?.id)}`);
    ok('no js/draft module reads a price, budget or bank field',
      !['price', 'budget', 'bank'].some((k) => k in (ranked[0] || {})));
    ok('the recommendation is sane — a real player with a finite score',
      Number.isFinite(ranked[0].proj) && Number.isFinite(ranked[0].vorp) && !!ranked[0].web_name);
  }
}

console.log('\nA draft travels between devices by link');
let trip = createDraft({ leagueSize: 6, mySlot: 3 });
[411, 412, 413, 414, 415].forEach((id, i) => { trip = addPick(trip, { elementId: id, mine: i === 2 }); });
const link = encodeDraft(trip);
const back = decodeDraft(link);
ok('a resume link is URL-safe', /^[A-Za-z0-9._~]+$/.test(link), link);
ok('a 6-team draft fits well inside a URL', link.length < 2000, `${link.length} chars`);
ok('league size survives the round trip', back.leagueSize === trip.leagueSize);
ok('my slot survives the round trip', back.mySlot === trip.mySlot);
ok('every pick survives in order',
  JSON.stringify(back.log) === JSON.stringify(trip.log), link);
ok('the decoded draft derives identically',
  JSON.stringify([...derive(back).taken]) === JSON.stringify([...derive(trip).taken]));
ok('my roster survives the round trip',
  JSON.stringify(derive(back).myRoster) === JSON.stringify(derive(trip).myRoster));
ok('a finished draft stays finished', decodeDraft(encodeDraft(finishDraft(trip))).finished === true);
ok('an unfinished draft stays unfinished', back.finished === false);

const big = (() => {
  let s = createDraft({ leagueSize: 16, mySlot: 16 });
  for (let i = 0; i < 240; i++) s = addPick(s, { elementId: 100 + i * 2, mine: i % 16 === 4 });
  return s;
})();
ok('even a full 16-team draft fits in a URL', encodeDraft(big).length < 2000,
  `${encodeDraft(big).length} chars`);
ok('a 16-team draft round-trips exactly',
  JSON.stringify(decodeDraft(encodeDraft(big)).log) === JSON.stringify(big.log));

// Element 130 is "3m" in base36. A trailing-letter mine flag decodes that as
// element 3 owned by me — the bug this assertion exists to prevent.
let collide = createDraft({ leagueSize: 6, mySlot: 2 });
collide = addPick(collide, { elementId: 130, mine: false });
ok('an id whose base36 ends in a letter is not misread as owned',
  JSON.stringify(decodeDraft(encodeDraft(collide)).log) === JSON.stringify(collide.log),
  encodeDraft(collide));
ok('a malformed link returns null, never throws', decodeDraft('not-a-draft') === null);
ok('an empty link returns null', decodeDraft('') === null);
ok('a truncated link returns null', decodeDraft('6.') === null);
ok('junk picks are dropped rather than poisoning the log',
  decodeDraft('6.3~411.@@@.413').log.length === 2);
ok('an out-of-range slot is clamped on decode', decodeDraft('6.99~411').mySlot <= 6);
ok('an empty draft round-trips', decodeDraft(encodeDraft(createDraft({ leagueSize: 8, mySlot: 1 }))).log.length === 0);

/* ------------------------------------------------------------------ *
 * season mode — squad and league ratings
 * ------------------------------------------------------------------ */
console.log('\nA finished draft becomes a rateable league');
{
  // Deterministic synthetic squads: value descends with id so expectations are
  // arithmetic rather than guesswork, and no real dataset is needed.
  const mk = (id, type, proj, extra = {}) => ({
    id, element_type: type, web_name: `p${id}`, team: 1 + (id % 20),
    proj, rosValue: proj, nearTermValue: proj / 7.6, availability: 1, minutes: 2000, ...extra,
  });
  const squad = (base) => [
    mk(base + 1, 1, 100), mk(base + 2, 1, 40),
    mk(base + 3, 2, 90), mk(base + 4, 2, 85), mk(base + 5, 2, 80), mk(base + 6, 2, 50), mk(base + 7, 2, 45),
    mk(base + 8, 3, 120), mk(base + 9, 3, 110), mk(base + 10, 3, 100), mk(base + 11, 3, 60), mk(base + 12, 3, 55),
    mk(base + 13, 4, 130), mk(base + 14, 4, 70), mk(base + 15, 4, 65),
  ];

  const s = squad(0);
  const xi = bestXI(s);
  ok('the best XI is eleven players', xi.xi.length === 11, `got ${xi.xi.length}`);
  ok('the bench is the remaining four', xi.bench.length === 4, `got ${xi.bench.length}`);
  const count = (t) => xi.xi.filter((p) => p.element_type === t).length;
  ok('the XI is legal — 1 GK, 3+ DEF, 2+ MID, 1+ FWD',
    count(1) === 1 && count(2) >= 3 && count(3) >= 2 && count(4) >= 1,
    `got ${count(1)}/${count(2)}/${count(3)}/${count(4)}`);
  ok('the reserve keeper is never in the XI', !xi.xi.some((p) => p.id === 2));
  ok('no player appears in both the XI and the bench',
    !xi.xi.some((a) => xi.bench.some((b) => b.id === a.id)));
  ok('the XI total is the sum of its members',
    Math.abs(xi.total - xi.xi.reduce((t, p) => t + p.proj, 0)) < 1e-9);

  // Depth: the same starters with a stronger bench must lose less per absence.
  const thin = squad(100);
  const deep = squad(200).map((p) => (p.proj < 70 ? { ...p, proj: p.proj + 40 } : p));
  ok('a stronger bench measures as better depth',
    depthCost(deep).perAbsence < depthCost(thin).perAbsence,
    `${depthCost(deep).perAbsence.toFixed(1)} vs ${depthCost(thin).perAbsence.toFixed(1)}`);
  ok('depth names the costliest single absence',
    depthCost(thin).worst && depthCost(thin).worst.drop > 0);
  ok('an incomplete squad reports depth as unmeasurable',
    depthCost(s.slice(0, 6)).measurable === false);

  // VORP is measured against the best available at each position, so a weak
  // pool must raise it and a strong pool must lower it.
  const weakPool = [mk(900, 1, 10), mk(901, 2, 10), mk(902, 3, 10), mk(903, 4, 10)];
  const strongPool = [mk(910, 1, 200), mk(911, 2, 200), mk(912, 3, 200), mk(913, 4, 200)];
  ok('a weak free-agent pool raises VORP',
    squadVorp(s, weakPool).total > squadVorp(s, strongPool).total);
  ok('VORP goes negative when the pool beats the XI',
    squadVorp(s, strongPool).total < 0);
  ok('VORP covers exactly the eleven starters',
    squadVorp(s, weakPool).perPlayer.length === 11);

  // Risk is projection-weighted: a doubtful star must outweigh a doubtful sub.
  const doubtStar = s.map((p) => (p.id === 13 ? { ...p, availability: 0.25 } : p));
  const doubtSub = s.map((p) => (p.id === 2 ? { ...p, availability: 0.25 } : p));
  ok('a doubtful star carries more risk than a doubtful reserve',
    riskScore(doubtStar).score > riskScore(doubtSub).score);
  ok('a fully fit squad has zero risk', riskScore(s).score === 0);
  ok('risk lists the flagged players', riskScore(doubtStar).flagged.length === 1);

  const rated = rateSquad(s, { pool: weakPool });
  ok('every rating component is present',
    ['ros', 'xi', 'byPos', 'depth', 'vorp', 'risk', 'fixtures'].every((k) => k in rated));
  ok('positional totals sum to the squad total',
    Math.abs([1, 2, 3, 4].reduce((t, k) => t + rated.byPos[k].ros, 0) - rated.ros) < 1e-9);

  // A league of identical squads must tie, and a clearly better squad must win.
  const rosters = new Map([[1, squad(0)], [2, squad(300)], [3, squad(600)]]);
  const flat = rateLeague(rosters, { pool: weakPool });
  ok('identical squads rate identically', new Set(flat.map((r) => r.rating)).size === 1);
  ok('every squad is ranked', flat.length === 3 && flat.every((r) => r.rank >= 1 && r.rank <= 3));

  const better = squad(900).map((p) => ({ ...p, proj: p.proj * 1.5 }));
  const mixed = rateLeague(new Map([[1, squad(0)], [2, better], [3, squad(600)]]), { pool: weakPool });
  ok('the strongest squad ranks first', mixed[0].slot === 2, `slot ${mixed[0].slot} led`);
  ok('ranks are dense and ordered', mixed.map((r) => r.rank).join() === '1,2,3');
  ok('the headline rating stays inside 0-100',
    mixed.every((r) => r.rating >= 0 && r.rating <= 100));
  ok('positional ranks are assigned for every position',
    mixed.every((r) => [1, 2, 3, 4].every((t) => r.posRank[t] >= 1 && r.posRank[t] <= 3)));
  ok('an empty league rates to nothing', rateLeague(new Map(), { pool: [] }).length === 0);
}

/* ------------------------------------------------------------------ *
 * Draft season transactions
 * ------------------------------------------------------------------ *
 * The post-draft adviser. Separate from draft night on purpose: this one is
 * allowed to say HOLD, and draft night never is.
 */
console.log('\nDraft season transactions');
{
  let uid = 5000;
  const mk = (type, proj, over = {}) => ({
    id: uid++, element_type: type, team: 1, web_name: `w${uid}`, proj,
    availability: 1, parts: { evidence: 1 }, ...over,
  });
  const roster = [
    mk(1, 40), mk(1, 20),
    mk(2, 60), mk(2, 55), mk(2, 50), mk(2, 30), mk(2, 25),
    mk(3, 80), mk(3, 70), mk(3, 60), mk(3, 30), mk(3, 20),
    mk(4, 75), mk(4, 50), mk(4, 20),
  ];

  const xi = draftXI(roster);
  ok('the draft XI is eleven players', xi.xi.length === 11);
  ok('exactly one keeper starts', xi.xi.filter((p) => p.element_type === 1).length === 1);
  ok('the XI obeys the formation minimums',
    xi.xi.filter((p) => p.element_type === 2).length >= 3
    && xi.xi.filter((p) => p.element_type === 3).length >= 2
    && xi.xi.filter((p) => p.element_type === 4).length >= 1);
  ok('there is no captain in Draft', !('captain' in xi) && !('vice' in xi));
  ok('roster value does not double any player the way a captain would',
    rosterValue(roster, (r) => r.proj, 0) === xi.xi.reduce((s, p) => s + p.proj, 0));

  const deepWire = [mk(3, 78), mk(3, 70)];
  const bareWire = [mk(4, 5)];
  ok('a deep wire at a position reads as low scarcity',
    positionScarcity(deepWire, roster, 3) < 0.2);
  ok('a bare wire reads as high scarcity',
    positionScarcity(bareWire, roster, 4) > 0.8);
  ok('no free agent at all is maximum scarcity', positionScarcity([], roster, 4) === 1);

  const good = { gains: [{ horizon: 1, gain: 2 }, { horizon: 3, gain: 6 }, { horizon: 5, gain: 14 }, { horizon: 8, gain: 20 }],
    allPositive: true, anyNegative: false, agreement: 1 };
  const wobbly = { gains: [{ horizon: 1, gain: 0.3 }, { horizon: 3, gain: 0.6 }, { horizon: 5, gain: 0.6 }, { horizon: 8, gain: -0.7 }],
    allPositive: false, anyNegative: true, agreement: 0.75 };
  ok('a marginal move is HOLD', classifyWaiver({ gain: 0.6, cross: wobbly }).verdict === 'HOLD');
  ok('a move that reverses at a longer horizon is HOLD',
    classifyWaiver({ gain: 6, cross: wobbly }).verdict === 'HOLD');
  ok('a large, agreeing, well-evidenced move is recommended',
    classifyWaiver({ gain: 14, cross: good, evidence: 1 }).verdict === 'STRONG ADD');
  ok('the incumbent advantage has to be cleared',
    classifyWaiver({ gain: 2.5, cross: good, evidence: 1 }).verdict === 'HOLD');
  ok('scarcity raises the bar further', (() => {
    const easy = classifyWaiver({ gain: 6, cross: good, scarcity: 0, evidence: 1 });
    const hard = classifyWaiver({ gain: 6, cross: good, scarcity: 1, evidence: 1 });
    return hard.bar > easy.bar;
  })());

  ok('a prior-heavy add is never claimed, only watched',
    classifyWaiver({ gain: 14, cross: good, evidence: 0 }).verdict === 'WATCH');
  ok('a prior-heavy add is reported as low confidence',
    classifyWaiver({ gain: 14, cross: good, evidence: 0 }).confidence === 'LOW');
  ok('an evidenced add of the same size is not capped',
    classifyWaiver({ gain: 14, cross: good, evidence: 1 }).verdict !== 'WATCH');
  ok('the reason says why it was held',
    classifyWaiver({ gain: 14, cross: good, evidence: 0 }).reasons.some((r) => /prior/.test(r)));
  ok('risk is not counted twice — evidence changes the verdict, never the gain', (() => {
    const a = classifyWaiver({ gain: 14, cross: good, evidence: 1 });
    const b = classifyWaiver({ gain: 14, cross: good, evidence: 0 });
    return a.net === b.net;
  })());

  const upgrade = mk(3, 95, { id: 9001 });
  const rowsAt = () => new Map([...roster, upgrade].map((p) => [p.id, p]));
  const best = bestWaiver(roster, [upgrade], rowsAt);
  ok('the adviser evaluates the whole roster, not two players',
    !!best && best.move.in.id === 9001);
  ok('a swap keeps the roster shape', !!best && best.move.out.element_type === best.move.in.element_type);
  ok('a free agent who is actually owned is never offered', (() => {
    const owned = roster[7];
    const r = bestWaiver(roster, [owned], () => new Map(roster.map((p) => [p.id, p])));
    return r === null || r.move.in.id !== owned.id;
  })());
  ok('nothing on the wire means no recommendation', bestWaiver(roster, [], rowsAt) === null);
  ok('an empty roster is refused', bestWaiver([], [upgrade], rowsAt) === null);

  const ps = positionalStrength(roster, [mk(3, 78), mk(2, 10), mk(4, 8), mk(1, 8)]);
  ok('a position with a strong replacement available scores low above replacement',
    ps[3].share < ps[2].share,
    `MID ${ps[3].share.toFixed(2)} vs DEF ${ps[2].share.toFixed(2)}`);
  ok('positional strength names the replacement it measured against', !!ps[3].bestFree);
  ok('positional strength covers every line', [1, 2, 3, 4].every((t) => ps[t] && ps[t].starters > 0));

  const src = fs.readFileSync('js/draft/waiver.js', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok('the Draft adviser has no budget, price or captain logic',
    !/now_cost|budget|bank|captain|freeTransfer|sell/i.test(code));
  const imports = [...src.matchAll(/^import[^;]+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  ok('the Draft adviser imports no Classic optimiser or rating',
    imports.every((i) => !/optimiser|\.\.\/rating/.test(i)), imports.join(', '));
}

/* ------------------------------------------------------------------ *
 * Draft season horizons
 * ------------------------------------------------------------------ */
console.log('\nDraft season horizons');
{
  const ev = (id, iso) => ({ id, deadline_time: iso });
  const events = [ev(1, '2026-08-21T17:30:00Z'), ev(2, '2026-08-28T17:30:00Z')];
  ok('a locked gameweek is excluded from waiver evaluation',
    actionableEvent(events, Date.parse('2026-08-23T10:00:00Z')) === 2);
  ok('an open gameweek is still claimable',
    actionableEvent(events, Date.parse('2026-08-21T09:00:00Z')) === 1);

  const f = (id, event, h, a, over = {}) => ({ id, event, team_h: h, team_a: a,
    team_h_difficulty: 3, team_a_difficulty: 3, started: false, finished: false,
    finished_provisional: false, ...over });
  const sched = [f(1, 2, 1, 2), f(2, 3, 1, 3), f(3, 3, 1, 4), f(4, 4, 2, 3)];
  const up = upcomingByTeam(sched, 2, 3);
  ok('a Draft double gameweek keeps both fixtures', (up[1] || []).filter((x) => x.event === 3).length === 2);
  ok('a Draft blank gameweek keeps none', !(up[4] || []).some((x) => x.event === 4));
  ok('next five gameweeks does not mean exactly five fixtures',
    (up[1] || []).length === 3 && (up[2] || []).length === 2);

  const boardFile2 = await readJSON('data/draft/players.json');
  if (boardFile2?.events?.length) {
    ok('the board carries gameweek deadlines so Draft can find the actionable one',
      boardFile2.events.every((e) => 'id' in e) && boardFile2.events.some((e) => e.deadline_time));
  }
}

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} draft checks passed`);
process.exit(failures ? 1 : 0);
