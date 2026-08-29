/**
 * Targeted Tier-B fetch for an explicit list of player-seasons.
 *
 * The normal Tier-B loop can only reach players the ESPN ROSTER CENSUS saw for
 * that competition-season, which is the right default — it is how the run stays
 * bounded. But it silently caps what any cohort can contain: a promoted club's
 * player who is missing from one season's census can never acquire minutes, and
 * the episode disappears into an attrition line rather than being fetchable.
 *
 * This asks ESPN for named player-seasons directly. Same endpoint, same
 * null-versus-measured-zero discipline, same permanent caching.
 */
import { getJSON } from '../lib/http.mjs';
import { readRows, mergeRows, paths, stamp } from './store.mjs';
import fs from 'node:fs';

const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
const LIST = process.env.WAREHOUSE_PS_LIST;
if (!LIST || !fs.existsSync(LIST)) {
  console.warn('✗ WAREHOUSE_PS_LIST not set or missing — nothing fetched, nothing written');
  process.exit(0);
}
const wanted = JSON.parse(fs.readFileSync(LIST, 'utf8'));   // [{competition, season, espnId, name}]
let budget = Number(process.env.WAREHOUSE_PS_PLAYERS || 400);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pick = (cats, cat, name) => {
  const c = (cats || []).find((x) => x.name === cat);
  const s = c?.stats?.find((x) => x.name === name);
  return s ? num(s.value) : null;
};
const FIELDS = [
  ['minutes', 'general', 'minutes'], ['starts', 'general', 'starts'],
  ['appearances', 'general', 'appearances'], ['subIns', 'general', 'subIns'],
  ['subOuts', 'general', 'subOuts'],
  ['goals', 'offensive', 'totalGoals'], ['assists', 'offensive', 'goalAssists'],
  ['shots', 'offensive', 'totalShots'], ['shotsOnTarget', 'offensive', 'shotsOnTarget'],
  ['keyPasses', 'offensive', 'shotAssists'], ['crosses', 'offensive', 'totalCrosses'],
  ['accurateCrosses', 'offensive', 'accurateCrosses'], ['passes', 'offensive', 'totalPasses'],
  ['accuratePasses', 'offensive', 'accuratePasses'], ['penaltyGoals', 'offensive', 'penaltyKickGoals'],
  ['penaltyShots', 'offensive', 'penaltyKickShots'], ['freeKickGoals', 'offensive', 'freeKickGoals'],
  ['headedGoals', 'offensive', 'headedGoals'], ['offsides', 'offensive', 'offsides'],
  ['tackles', 'defensive', 'totalTackles'], ['interceptions', 'defensive', 'interceptions'],
  ['clearances', 'defensive', 'totalClearance'], ['blockedShots', 'defensive', 'blockedShots'],
  ['saves', 'goalKeeping', 'saves'], ['goalsConceded', 'goalKeeping', 'goalsConceded'],
  ['cleanSheets', 'goalKeeping', 'cleanSheet'], ['penaltiesSaved', 'goalKeeping', 'penaltyKicksSaved'],
  ['yellowCards', 'general', 'yellowCards'], ['redCards', 'general', 'redCards'],
  ['ownGoals', 'general', 'ownGoals'], ['foulsCommitted', 'general', 'foulsCommitted'],
];
const statsFrom = (cats) => Object.fromEntries(FIELDS.map(([k, c, n]) => [k, pick(cats, c, n)]));

const byKey = new Map();
for (const w of wanted) {
  const k = `${w.competition}|${w.season}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(w);
}

let fetched = 0; let unknown = 0;
for (const [key, list] of byKey) {
  if (budget <= 0) break;
  const [comp, seasonStr] = key.split('|');
  const season = Number(seasonStr);
  const path = paths.espnPlayerSeasons(comp, season);
  const have = new Set((await readRows(path)).map((r) => r.espnId));
  const todo = list.filter((w) => !have.has(w.espnId));
  if (!todo.length) continue;

  const rows = [];
  for (const w of todo) {
    if (budget <= 0) break;
    const st = await getJSON(`${CORE}/${comp}/seasons/${season}/types/1/athletes/${w.espnId}/statistics`,
      { browserUA: true }).catch(() => null);
    budget -= 1;
    const cats = st?.splits?.categories;
    // No statistics block = ESPN cannot describe it. Unknown, not zero.
    if (!Array.isArray(cats) || !cats.length) { unknown += 1; continue; }
    rows.push(stamp({ espnId: w.espnId, name: w.name ?? null, tier: 'B', ...statsFrom(cats) },
      { source: 'espn-core-athlete-direct', sourceId: w.espnId, competition: comp, season, fetchedAt: new Date().toISOString() }));
    fetched += 1;
  }
  if (rows.length) {
    const res = await mergeRows(path, rows, (r) => r.espnId);
    console.log(`  ${comp.padEnd(8)} ${season}  +${rows.length} direct, ${res.total} stored`);
  }
}
console.log(`\n✓ ${fetched} fetched, ${unknown} had no statistics block (unknown, correctly not stored)`);
