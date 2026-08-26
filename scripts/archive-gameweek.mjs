/**
 * Freeze each gameweek once it is over, so the app can look back at it.
 *
 * The tracker only ever held the CURRENT gameweek (`data/live.json`, rewritten
 * every 30 minutes). Stepping back to an earlier gameweek needs its numbers
 * kept, and they are only worth keeping in two halves:
 *
 *   projected     what the model said BEFORE the deadline
 *   availability  what FPL said about the player's fitness at that moment
 *   diagnostics   what the opportunity model believed at that moment
 *   actual        what the player then scored
 *
 * The middle two are evidence collection, not display. Historical FPL data
 * cannot distinguish "injured", "benched" and "not in the squad" — every one
 * of them is simply an absence of minutes, and `history_past` carries season
 * totals with no availability at all. That makes P(start | available)
 * unestimable from anything already on disk. The only way to get it is to
 * start writing down what was known before each deadline, from now on, which
 * is what these two maps are for. Nothing reads them yet.
 *
 * Those two together are the comparison the squad view draws. The projection
 * has to be captured before the deadline or it is hindsight — FPL wipes and
 * refills the season totals AT the deadline, so a projection recomputed
 * afterwards is a different quantity wearing the same name. This script
 * therefore writes the projection every run while the deadline is still ahead,
 * and stops touching it once the gameweek locks.
 *
 * **`finished` is not the signal.** It stays false until FPL's confirmation
 * pass the morning after the last match. The reliable test is that every
 * fixture in the event is `finished_provisional`, which means played with bonus
 * awarded. The file is rewritten until `data_checked` turns true, then frozen —
 * that is the point after which nothing can move.
 *
 * Cheap by construction: ~60KB per gameweek once the pre-deadline evidence is
 * included, ~2.3MB for a season, and
 * each is written a handful of times and then never again. `data/live.json` is
 * 112KB rewritten every half hour, so this adds nothing next to what the
 * pipeline already does.
 *
 * **Keyed by `code`, never by element id.** The live endpoint returns classic
 * ids, but Draft and classic disagree on ids for 21 of 587 players — reading
 * this file with a Draft id would silently show one player another player's
 * score, in 21 places, with nothing on screen to indicate it. `code` is stable
 * across both games and across seasons. See CLAUDE.md.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { projectAll, availabilitySource, teamDefence } from '../js/model.js';
import { hydrate } from '../js/prior.js';
import { carryForward, schemaFor } from './lib/archive-schema.mjs';
import { parseReturnBoundary } from '../js/availability-news.js';

const FPL = 'https://fantasy.premierleague.com/api';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const DIR = 'data/history/gw';

const readJSON = async (p, fallback = null) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};

const boot = await readJSON('data/bootstrap.json');
const fixtures = await readJSON('data/fixtures.json', []);
if (!boot?.events?.length) {
  console.log('no bootstrap — nothing to archive');
  process.exit(0);
}
await mkdir(DIR, { recursive: true });

const prior = await readJSON('data/draft/prior-2526.json', null);
const espn = await readJSON('data/espn-history.json', null);
const now = Date.now();

/** Coerce to a finite number, or 0. FPL sends some counts as strings. */
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
/** Two decimals, or null — never a guessed zero for a value we do not have. */
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** classic element id -> code, the identifier both games share. */
const codeOf = new Map(boot.elements.map((e) => [e.id, e.code]));

/** Trim to what the squad view needs. Arrays, not objects — 9KB against 112KB. */
const trimActual = (rows) => Object.fromEntries(rows
  .map((e) => {
    const st = e.stats || e;
    const code = codeOf.get(e.id);
    return code ? [code, [st.total_points ?? 0, st.minutes ?? 0, st.bonus ?? 0, st.bps ?? 0]] : null;
  })
  .filter(Boolean));

let wrote = 0;
for (const ev of boot.events) {
  const file = `${DIR}/${ev.id}.json`;
  const existing = await readJSON(file, null);
  if (existing?.final) continue;                       // settled; never touch again

  const deadline = Date.parse(ev.deadline_time);
  /* Only the gameweek being played and the one being planned. Projecting GW38
     in August is meaningless AND expensive: every future gameweek would be
     rewritten on every run, which is the churn this design exists to avoid.
     Everything earlier is already archived; everything later gets its turn. */
  const inPlay = ev.is_current || ev.is_next;
  const beforeDeadline = inPlay && Number.isFinite(deadline) && now < deadline;
  const evFixtures = fixtures.filter((f) => f.event === ev.id);
  const played = evFixtures.length > 0 && evFixtures.every((f) => f.finished_provisional);
  if (!inPlay && !played) continue;

  /* ---- the projection, while it is still a prediction ---- */
  let projected = existing?.projected ?? null;
  /* Where the projection came from, when it was not captured live. GW1 was
     recovered from git after the fact; every gameweek since is captured before
     its own deadline and carries no such note. Preserved across rewrites so the
     provenance cannot be quietly lost when the actuals land. */
  const projectedFrom = existing?.projectedFrom ?? null;
  /* Availability and model diagnostics are frozen at the SAME instant as the
     projection — inside this branch, never outside it. Captured after the
     deadline they would describe a squad already announced, which is exactly
     the hindsight this file exists to prevent. Preserved across later rewrites
     the same way `projectedFrom` is, so settling the actuals cannot overwrite
     what was believed beforehand. */
  let availability = null;
  let diagnostics = null;
  let news = null;
  let capturedAt = null;
  let teamContext = null;

  if (beforeDeadline) {
    const rows = projectAll(prior ? hydrate(boot, prior, {}, espn) : boot,
      fixtures, { horizon: 1, fromEvent: ev.id }).rows;
    projected = Object.fromEntries(rows
      .map((r) => {
        const code = r.code ?? codeOf.get(r.id);
        return code ? [code, Math.round(r.proj * 100) / 100] : null;
      })
      .filter(Boolean));

    /* Compact arrays rather than objects: 610 players x 38 gameweeks is a lot
       of repeated keys, and the field order is documented here and asserted in
       scripts/test.mjs. `null` is preserved as null throughout — FPL leaves
       `chance_of_playing_*` unset for players it has no doubt about, so a
       missing value is itself the evidence and must never be filled in with a
       guessed 100. */
    /* When the pre-deadline snapshot was actually taken. `updatedAt` cannot
       answer this: it is the last write of any kind, so for a settled gameweek
       it is days AFTER the deadline, once the actuals landed. Recording the
       capture instant separately is what lets a later backtest compute
       `deadline - capturedAt` and know how stale the frozen projection was —
       and it comes from the run itself rather than being inferred from a git
       commit, which only says when something was committed. */
    capturedAt = new Date().toISOString();
    availability = {};
    diagnostics = {};
    news = {};
    const byId = new Map(boot.elements.map((e) => [e.id, e]));

    /* Fixture context, frozen because it cannot be rebuilt later: teamDefence()
       reads live minutes and xGC, and both are rewritten on every refresh. The
       provenance flag records whether a club had enough real evidence or fell
       back to an editorial strength rating. */
    const hydrated = prior ? hydrate(boot, prior, {}, espn) : boot;
    const defence = teamDefence(hydrated.elements, hydrated.teams);
    const evidenced = {};
    for (const e of hydrated.elements) {
      const mins = num(e.evidenceMinutes) || num(e.minutes);
      if (mins >= 450 && num(e.expected_goals_conceded_per_90) > 0) {
        evidenced[e.team] = (evidenced[e.team] || 0) + 1;
      }
    }
    teamContext = {};
    for (const t of hydrated.teams) {
      if (defence[t.id] == null) continue;
      teamContext[t.id] = [r2(defence[t.id]), (evidenced[t.id] || 0) >= 3 ? 'measured' : 'fallback'];
    }
    for (const e of boot.elements) {
      const code = e.code ?? codeOf.get(e.id);
      if (!code) continue;
      availability[code] = [
        e.id,
        e.status ?? null,
        e.chance_of_playing_this_round ?? null,
        e.chance_of_playing_next_round ?? null,
        num(e.minutes),
        num(e.starts),
        e.news_added ?? null,
      ];
      if (e.news && e.news.trim()) news[code] = e.news.trim();
    }
    for (const r of rows) {
      const code = r.code ?? codeOf.get(r.id);
      const q = r.parts;
      if (!code || !q) continue;
      const el = byId.get(r.id);
      const parsed = el ? parseReturnBoundary(el) : null;
      diagnostics[code] = [
        r2(q.expMins), r2(q.pStart), r2(q.pPlay), r2(q.p60),
        r2(q.productionConfidence ?? q.evidence), r2(q.minutesConfidence),
        r2(q.availability), q.availSource ?? (el ? availabilitySource(el) : null),
        parsed ? new Date(parsed.boundary).toISOString().slice(0, 10) : null,
      ];
    }
  }

  /* ---- the actuals, once every match has been played ---- */
  let actual = existing?.actual ?? null;
  if (played) {
    const res = await fetch(`${FPL}/event/${ev.id}/live/`, { headers: { 'User-Agent': UA } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (res?.elements?.length) actual = trimActual(res.elements);
    else console.log(`  ! GW${ev.id}: live fetch failed, keeping what is on disk`);
  }

  if (!projected && !actual) continue;

  await writeFile(file, `${JSON.stringify({
    event: ev.id,
    deadline: ev.deadline_time,
    /* Frozen only after FPL's confirmation pass. Until then bonus can still
       move, so the file stays open to correction. */
    final: Boolean(ev.data_checked),
    /* Stated in the file so a consumer cannot guess wrong. */
    keyedBy: 'code',
    averageScore: ev.average_entry_score ?? null,
    highestScore: ev.highest_score ?? null,
    updatedAt: new Date().toISOString(),
    ...(projectedFrom ? { projectedFrom } : {}),
    /* Schema 2 adds availability/diagnostics/news. Gameweeks archived before
       it simply lack those keys and stay readable — they are NOT backfilled,
       because today's availability is not what was known at their deadline. */
    schema: schemaFor(availability ?? existing?.availability, existing?.schema),
    ...(carryForward(existing?.capturedAt, capturedAt)
      ? { capturedAt: carryForward(existing?.capturedAt, capturedAt) } : {}),
    /* [ elementId, status, chanceThisRound, chanceNextRound, minutes, starts, newsAdded ] */
    /* [ defence, provenance ] per team id */
    ...(carryForward(existing?.teamContext, teamContext)
      ? { teamContext: carryForward(existing?.teamContext, teamContext) } : {}),
    ...(carryForward(existing?.availability, availability)
      ? { availability: carryForward(existing?.availability, availability) } : {}),
    /* [ expMins, pStart, pPlay, p60, productionConfidence, minutesConfidence ] */
    ...(carryForward(existing?.diagnostics, diagnostics)
      ? { diagnostics: carryForward(existing?.diagnostics, diagnostics) } : {}),
    ...(Object.keys(carryForward(existing?.news, news) || {}).length
      ? { news: carryForward(existing?.news, news) } : {}),
    projected,
    actual,
  })}\n`);
  wrote++;
  console.log(`  ✓ GW${ev.id} ${projected ? 'projected' : '—'} ${actual ? 'actual' : '—'}`
    + `${ev.data_checked ? ' (final)' : ''}`);
}

const files = existsSync(DIR) ? (await readdir(DIR)).filter((f) => f.endsWith('.json')) : [];
console.log(`${wrote} gameweek file${wrote === 1 ? '' : 's'} written; ${files.length} archived in total`);
