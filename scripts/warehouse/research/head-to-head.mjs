/**
 * Head-to-head research capability. NOT a projection feature.
 *
 * The programme's position on H2H is that a raw historical record between two
 * clubs is almost certainly a restatement of how good those clubs were, and
 * that it only earns model weight if it explains something left over AFTER
 * current strength and venue are accounted for. This file builds the queries
 * that make that test possible later, and reports honestly on what the data can
 * and cannot support today.
 *
 * ── Team versus team: available ──
 *
 * Every collected team-match row carries the opponent, venue side, goals, and
 * the 28-statistic block for both sides. That is enough to return a real
 * matchup history and, more importantly, to compute a RESIDUAL: how each club
 * performed in this fixture relative to its own season average. A matchup
 * effect that exists only in raw goals and vanishes in residuals is the
 * strength artefact the programme predicted.
 *
 * ── Player versus team: not available, and not faked ──
 *
 * Player-level H2H needs player-MATCH evidence. The warehouse has player-SEASON
 * aggregates, and a season total cannot be attributed to individual opponents.
 * Splitting one evenly across a season's fixtures would manufacture per-opponent
 * numbers that look exactly like measurements, so this file refuses to and says
 * so. The only player-match store is the existing Premier League one, which
 * holds a single season; the report states its size rather than implying more.
 */
import fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import { readRows, paths } from '../store.mjs';
import { COMPETITIONS, WAREHOUSE_SEASONS } from '../config.mjs';

const OUT = 'data/warehouse/research/head-to-head.json';

/** Every team-match row the warehouse holds, flattened. */
async function allRows() {
  const out = [];
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      for (const r of await readRows(paths.teamMatch(c.key, s))) out.push(r);
    }
  }
  return out;
}

const rows = await allRows();

/** Season averages per club, the baseline a residual is measured against. */
function seasonAverages(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.competition}|${r.season}|${r.team}`;
    const a = by.get(k) || { n: 0, gf: 0, ga: 0, shots: 0, shotsAg: 0, poss: 0 };
    a.n += 1; a.gf += r.goalsFor ?? 0; a.ga += r.goalsAgainst ?? 0;
    a.shots += r.stats?.totalShots ?? 0; a.shotsAg += r.opponentStats?.totalShots ?? 0;
    a.poss += r.stats?.possessionPct ?? 0;
    by.set(k, a);
  }
  const out = new Map();
  for (const [k, a] of by) {
    out.set(k, { n: a.n, gf: a.gf / a.n, ga: a.ga / a.n, shots: a.shots / a.n, shotsAg: a.shotsAg / a.n, poss: a.poss / a.n });
  }
  return out;
}
const avgs = seasonAverages(rows);

/**
 * Matchup history for one pair of clubs, with residuals.
 *
 * @returns meetings, and for each: the raw figures plus the same figures
 *          expressed as a deviation from that club's own season average. The
 *          residual is the column a later experiment would actually test.
 */
export function teamVsTeam(teamA, teamB, { competition = null } = {}) {
  const meetings = rows.filter((r) => r.team === teamA && r.opponent === teamB
    && (!competition || r.competition === competition));
  return meetings.map((r) => {
    const a = avgs.get(`${r.competition}|${r.season}|${r.team}`);
    return {
      competition: r.competition, season: r.season, date: r.date,
      home: r.home, formation: r.formation,
      goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst,
      shots: r.stats?.totalShots ?? null, shotsAgainst: r.opponentStats?.totalShots ?? null,
      possession: r.stats?.possessionPct ?? null,
      residual: a ? {
        goalsFor: +((r.goalsFor ?? 0) - a.gf).toFixed(3),
        goalsAgainst: +((r.goalsAgainst ?? 0) - a.ga).toFixed(3),
        shots: +((r.stats?.totalShots ?? 0) - a.shots).toFixed(3),
        possession: +((r.stats?.possessionPct ?? 0) - a.poss).toFixed(3),
      } : null,
    };
  }).sort((x, y) => String(y.date).localeCompare(String(x.date)));
}

/* ---- capability report -------------------------------------------- */
const pairs = new Map();
for (const r of rows) {
  const k = [r.team, r.opponent].sort().join('-') + '|' + r.competition;
  pairs.set(k, (pairs.get(k) || 0) + 1);
}
const withRepeat = [...pairs.values()].filter((n) => n >= 4).length;

/* Player-match evidence: the existing production store only. */
let playerMatchFiles = 0; let playerMatchRows = 0;
try {
  const files = (await readdir('data/history/matches')).filter((f) => f.endsWith('.json'));
  playerMatchFiles = files.length;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(`data/history/matches/${f}`, 'utf8'));
    playerMatchRows += j.teams.flatMap((t) => t.players).length;
  }
} catch { /* store absent */ }

const report = {
  builtAt: new Date().toISOString(),
  teamVsTeam: {
    available: true,
    teamMatchRows: rows.length,
    distinctPairsWithinCompetition: pairs.size,
    pairsWithAtLeast4Meetings: withRepeat,
    residualsSupported: true,
    note: 'Residuals are expressed against each club\'s own season average, so a matchup effect can be '
      + 'separated from the clubs simply being good or bad. That separation is the whole test.',
  },
  playerVsTeam: {
    available: false,
    reason: 'Player-level H2H needs player-MATCH evidence. The warehouse holds player-SEASON aggregates, '
      + 'and a season total cannot be attributed to individual opponents. Dividing one across a season\'s '
      + 'fixtures would fabricate per-opponent figures indistinguishable from measurements.',
    onlyPlayerMatchStore: 'data/history/matches (existing production store, Premier League, current season)',
    playerMatchFiles, playerMatchRows,
  },
  modelWeight: 'ZERO, deliberately. H2H may become a feature only if it explains residual variation after '
    + 'current team strength, venue and role are accounted for.',
};
fs.mkdirSync('data/warehouse/research', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log('HEAD-TO-HEAD RESEARCH CAPABILITY\n');
console.log('team vs team:   AVAILABLE');
console.log(`  team-match rows                   ${rows.length}`);
console.log(`  distinct club pairs               ${pairs.size}`);
console.log(`  pairs with >=4 meetings           ${withRepeat}`);
console.log('  residuals vs season average       supported');
console.log('\nplayer vs team:  NOT AVAILABLE');
console.log(`  reason: only season aggregates exist; per-opponent attribution would be fabricated`);
console.log(`  only player-match store: data/history/matches — ${playerMatchFiles} matches, ${playerMatchRows} player-match rows`);

/* A worked example, so the capability is demonstrated rather than asserted. */
const sample = rows.find((r) => r.competition === 'eng.1' && r.stats?.totalShots != null);
if (sample) {
  const hist = teamVsTeam(sample.team, sample.opponent, { competition: 'eng.1' });
  console.log(`\nworked example — ${sample.team} vs ${sample.opponent} (eng.1), ${hist.length} meeting(s):`);
  for (const h of hist.slice(0, 4)) {
    console.log(`  ${h.season} ${String(h.date).slice(0, 10)} ${h.home ? 'H' : 'A'}  `
      + `${h.goalsFor}-${h.goalsAgainst}  shots ${h.shots}  poss ${h.possession}`
      + (h.residual ? `   residual: goals ${h.residual.goalsFor >= 0 ? '+' : ''}${h.residual.goalsFor}, shots ${h.residual.shots >= 0 ? '+' : ''}${h.residual.shots}` : ''));
  }
}
console.log(`\n→ ${OUT}`);
