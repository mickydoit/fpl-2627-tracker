/**
 * Draft engine checks. Run with `node scripts/test-draft.mjs`.
 * Kept separate from scripts/test.mjs so the classic model and optimiser
 * suite stays untouched and its regression guarantee stays legible.
 */
import { readJSON } from './lib/io.mjs';
import { DRAFT_CONFIG, QUOTA, STARTER_QUOTA, ROUNDS,
  LEAGUE_SIZE_DEFAULT, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX } from '../js/draft/config.js';

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

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} draft checks passed`);
process.exit(failures ? 1 : 0);
