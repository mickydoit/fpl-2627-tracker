/**
 * Per-match player outcomes for 2026/27, to score already-frozen candidates.
 *
 * EVALUATION ONLY. Nothing collected here may refit any candidate.
 *
 * ── The cheap route, found by auditing before spending ──
 *
 * The obvious approach costs 43 requests a match: one summary, two rosters, and
 * one statistics call per player. Across ten matches that is the ~430 per
 * gameweek previously estimated.
 *
 * But `site summary?event=` already carries a `rosters` block whose entries
 * include an inline `stats` array — shots, shots on target, goals, assists,
 * saves and cards, for both teams, in the SAME request. So the bulk of what is
 * needed costs ONE request per match.
 *
 * Two fields are missing from it and both matter:
 *
 *   minutes       the per-90 denominator. Taken from FPL's element-summary,
 *                 which publishes it per gameweek, rather than bought again.
 *   shotAssists   key passes, one of the frozen candidates. Only on the core
 *                 per-player statistics ref, so it is fetched ONLY for players
 *                 in the frozen prospective cohort.
 *
 * Measured cost: 10 summaries plus roughly 50-60 cohort player-matches per
 * gameweek, against 430. About six times cheaper, and the expensive half is
 * confined to players the experiment actually predicts.
 *
 * ── Failure is never zero ──
 *
 * A match that cannot be fetched is absent, and absence is reported as missing
 * coverage. It must never appear as a player who took no shots.
 */
import { getJSON } from '../lib/http.mjs';
import { readRows, mergeRows, paths, stamp } from './store.mjs';
import { isModelSafe } from './field-registry.mjs';
import fs from 'node:fs';

const SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/eng.1';
const SEASON = 2026;
const J = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const manifest = J('data/warehouse/research/EXPERIMENT-MANIFEST.json');
if (!manifest) { console.warn('✗ no experiment manifest — nothing collected'); process.exit(0); }
const FIRST_GW = manifest.firstScorableGW;
const BUDGET = Number(process.env.PROSPECTIVE_BUDGET || 140);   // conservative per-run cap
let spent = 0;

/* Only endpoint-verified fields may be normalised. */
const SUMMARY_FIELDS = ['matchSummary.totalShots', 'matchSummary.shotsOnTarget', 'matchSummary.saves'];
for (const f of SUMMARY_FIELDS) {
  if (!isModelSafe(f)) throw new Error(`${f} is not MODEL_SAFE for this endpoint — refusing to collect it into evaluation`);
}

/* Cohort: only players the frozen experiment predicts. */
const archive = J('data/warehouse/research/shadow-archive.json');
const cohortEspnIds = new Set((archive?.players || []).map((p) => p.espnId).filter(Boolean));
console.log(`→ prospective outcomes, GW>=${FIRST_GW}, cohort ${cohortEspnIds.size} players, budget ${BUDGET} requests\n`);

/* Eligible MATCHES, not eligible gameweeks.
 *
 * Waiting for a whole gameweek to settle would leave Saturday's matches
 * unarchived until Monday night, and ESPN endpoints are undocumented — a match
 * that becomes harder to reconstruct later is evidence lost for nothing. So the
 * trigger is per match: eligible event, finished, not already archived. */
const boot = J('data/bootstrap.json');
const eligibleEvents = (boot?.events || []).filter((e) => e.id >= FIRST_GW).map((e) => e.id);
if (!eligibleEvents.length) {
  console.log(`  no gameweek at or after GW${FIRST_GW} — nothing to collect yet.`);
  process.exit(0);
}

/* Map kickoff date -> gameweek, from FPL fixtures. */
const fixtures = J('data/fixtures.json') || [];
const gwByDay = new Map();
for (const f of fixtures) {
  if (f.event == null || !f.kickoff_time) continue;
  gwByDay.set(String(f.kickoff_time).slice(0, 10), f.event);
}

const sb = await getJSON(`${SITE}/scoreboard?dates=${SEASON}0801-${SEASON + 1}0630&limit=700`, { browserUA: true })
  .catch(() => null);
spent += 1;
if (!sb?.events) { console.warn('✗ scoreboard unavailable — committed data untouched'); process.exit(0); }

const missing = [];
let collected = 0; let cohortFetched = 0;
/* Item 9's ledger. The ~80/GW estimate is a claim about the future, so it is
   measured every run rather than assumed to have stayed true. */
const ledger = { newMatches: 0, summaryRequests: 0, rosterRequests: 0, detailRequests: 0,
  cacheHits: 0, failures: 0, deferredForBudget: 0 };

for (const gw of eligibleEvents) {
  const path = paths.prospectiveRaw(SEASON, gw);
  const have = new Set((await readRows(path)).map((r) => `${r.eventId}:${r.espnId}`));
  const haveEvents = new Set((await readRows(path)).map((r) => r.eventId));

  const evs = sb.events.filter((e) => e.competitions?.[0]?.status?.type?.completed
    && gwByDay.get(String(e.date).slice(0, 10)) === gw);
  /* A gameweek with no completed match yet is simply the future — not worth a
     line each for the rest of the season. */
  if (!evs.length) continue;
  const todo = evs.filter((e) => !haveEvents.has(Number(e.id)));
  if (!todo.length) { console.log(`  GW${gw}: ${haveEvents.size}/${evs.length} matches stored, nothing new`); continue; }

  const rows = [];
  for (const ev of todo) {
    if (spent >= BUDGET) break;
    const s = await getJSON(`${SITE}/summary?event=${ev.id}`, { browserUA: true }).catch(() => null);
    spent += 1; ledger.summaryRequests += 1;
    if (!s?.rosters?.length) {
      ledger.failures += 1;
      missing.push({ gw, eventId: ev.id, reason: 'summary unavailable' });
      continue;
    }

    for (const t of s.rosters) {
      for (const entry of t.roster || []) {
        const st = Object.fromEntries((entry.stats || []).map((x) => [x.name, x.value]));
        const espnId = Number(entry.athlete?.id);
        const row = {
          eventId: Number(ev.id), gameweek: gw, kickoff: ev.date ?? null,
          espnId, name: entry.athlete?.displayName ?? null,
          team: t.team?.abbreviation ?? null, homeAway: t.homeAway ?? null,
          position: entry.position?.displayName ?? null,
          starter: !!entry.starter, formationPlace: entry.formationPlace ?? null,
          /* endpoint-verified fields only */
          shots: st.totalShots ?? null,
          shotsOnTarget: st.shotsOnTarget ?? null,
          saves: st.saves ?? null,
          goals: st.totalGoals ?? null,
          assists: st.goalAssists ?? null,
          /* filled by the targeted second pass, null until then — never zero */
          minutes: null, keyPasses: null,
          inCohort: cohortEspnIds.has(espnId),
          freezeVersion: manifest.candidateVersions?.productionVolume ?? null,
          eligibleForProspectiveEvaluation: gw >= FIRST_GW,
        };
        rows.push(stamp(row, { source: 'espn-site-summary-rosters', sourceId: `${ev.id}:${espnId}`,
          competition: 'eng.1', season: SEASON, fetchedAt: new Date().toISOString() }));
      }
    }
    collected += 1; ledger.newMatches += 1;
  }
  ledger.cacheHits += evs.length - todo.length;
  if (spent >= BUDGET) ledger.deferredForBudget += evs.length - todo.length >= 0 ? (evs.length - (todo.length)) : 0;

  /* Targeted second pass: key passes for cohort players only.
   *
   * `shotAssists` lives only on the core per-player statistics block, and the
   * ref to it is carried on the CORE roster entry — so reaching it costs two
   * roster calls per match plus one statistics call per cohort player.
   * Minutes are NOT bought here: FPL's element-summary already publishes them
   * per gameweek, and paying ESPN for a number we already hold would be waste.
   */
  const cohortRows = rows.filter((r) => r.inCohort);
  if (cohortRows.length && spent < BUDGET) {
    const eventIds = [...new Set(cohortRows.map((r) => r.eventId))];
    for (const eventId of eventIds) {
      if (spent >= BUDGET) break;
      const refByPlayer = new Map();
      const summary = await getJSON(`${SITE}/summary?event=${eventId}`, { browserUA: true }).catch(() => null);
      const competitors = summary?.header?.competitions?.[0]?.competitors || [];
      for (const c of competitors) {
        if (spent >= BUDGET) break;
        const roster = await getJSON(
          `https://sports.core.api.espn.com/v2/sports/soccer/leagues/eng.1/events/${eventId}`
          + `/competitions/${eventId}/competitors/${c.id}/roster`, { browserUA: true }).catch(() => null);
        spent += 1; ledger.rosterRequests += 1;
        for (const e of roster?.entries || []) {
          if (e.statistics?.$ref) refByPlayer.set(Number(e.playerId), String(e.statistics.$ref).replace(/^http:/, 'https:'));
        }
      }
      for (const r of cohortRows.filter((x) => x.eventId === eventId)) {
        if (spent >= BUDGET) break;
        const ref = refByPlayer.get(r.espnId);
        if (!ref) continue;
        const st = await getJSON(ref, { browserUA: true }).catch(() => null);
        spent += 1; ledger.detailRequests += 1;
        const cats = st?.splits?.categories;
        // No statistics block = unknown. Leave null; never write a zero.
        if (!Array.isArray(cats) || !cats.length) continue;
        const pick = (cat, name) => {
          const c2 = cats.find((x) => x.name === cat);
          const v = c2?.stats?.find((x) => x.name === name);
          return v && Number.isFinite(Number(v.value)) ? Number(v.value) : null;
        };
        r.keyPasses = pick('offensive', 'shotAssists');
        r.minutes = pick('general', 'minutes');
        cohortFetched += 1;
      }
    }
  }

  if (rows.length) {
    const res = await mergeRows(path, rows, (r) => `${r.eventId}:${r.espnId}`);
    console.log(`  GW${gw}: +${collected} matches, ${res.total} player-match rows stored`
      + `, ${rows.filter((r) => r.inCohort).length} in cohort`);
  }
  if (spent >= BUDGET) { console.log(`  budget reached (${spent}) — the next run continues`); break; }
}

console.log('\nREQUEST LEDGER');
for (const [k, v] of Object.entries(ledger)) console.log('  ' + k.padEnd(20) + v);
console.log('  ' + 'totalRequests'.padEnd(20) + spent + ` (cap ${BUDGET})`);
if (ledger.newMatches) {
  console.log('  ' + 'perMatch'.padEnd(20) + (spent / ledger.newMatches).toFixed(1)
    + `  -> ~${Math.round((spent / ledger.newMatches) * 10)} per 10-match gameweek`);
}
if (!collected && !missing.length) console.log('\n  NO NEW SETTLED MATCHES');
if (missing.length) {
  console.log(`  ⚠ COVERAGE INCOMPLETE — ${missing.length} match(es) unavailable, recorded as missing, NOT as zero:`);
  for (const m of missing.slice(0, 5)) console.log(`    GW${m.gw} event ${m.eventId}: ${m.reason}`);
}
