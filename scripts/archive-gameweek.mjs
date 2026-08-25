/**
 * Freeze each gameweek once it is over, so the app can look back at it.
 *
 * The tracker only ever held the CURRENT gameweek (`data/live.json`, rewritten
 * every 30 minutes). Stepping back to an earlier gameweek needs its numbers
 * kept, and they are only worth keeping in two halves:
 *
 *   projected  what the model said BEFORE the deadline
 *   actual     what the player then scored
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
 * Cheap by construction: one 9KB file per gameweek, ~0.3MB for a season, and
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
import { projectAll } from '../js/model.js';
import { hydrate } from '../js/prior.js';

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
  if (beforeDeadline) {
    const rows = projectAll(prior ? hydrate(boot, prior, {}, espn) : boot,
      fixtures, { horizon: 1, fromEvent: ev.id }).rows;
    projected = Object.fromEntries(rows
      .map((r) => {
        const code = r.code ?? codeOf.get(r.id);
        return code ? [code, Math.round(r.proj * 100) / 100] : null;
      })
      .filter(Boolean));
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
    projected,
    actual,
  })}\n`);
  wrote++;
  console.log(`  ✓ GW${ev.id} ${projected ? 'projected' : '—'} ${actual ? 'actual' : '—'}`
    + `${ev.data_checked ? ' (final)' : ''}`);
}

const files = existsSync(DIR) ? (await readdir(DIR)).filter((f) => f.endsWith('.json')) : [];
console.log(`${wrote} gameweek file${wrote === 1 ? '' : 's'} written; ${files.length} archived in total`);
