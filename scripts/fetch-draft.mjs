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
import { poolPlayerSeasons, PRIOR_DEFAULTS, espnEvidence } from '../js/prior.js';
import { inferGamesPlayed } from '../js/model.js';

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

/* The board used to project from the frozen 2025/26 prior alone, which was
   right on draft night and wrong from GW1 onward: this season's minutes and
   returns simply never reached it, so Draft would have run all season on last
   season's football while Classic moved on. The two seasons are pooled here,
   through the same js/prior.js helper the Classic model uses, so there is one
   blend rather than two that can drift apart. Done at fetch time because the
   Draft pages read a committed board and do no hydration of their own. */
const espnHistory = await readJSON('data/espn-history.json').catch(() => null);
const gamesThis = inferGamesPlayed(classicBoot.elements);
const poolGames = gamesThis + PRIOR_DEFAULTS.lastSeasonWeight * PRIOR_DEFAULTS.lastSeasonGames;
let pooledCount = 0;
let espnApplied = 0;

const players = classicBoot.elements.map((p) => {
  const d = draftByCode.get(p.code);
  const model = poolPlayerSeasons(p, prior.players[p.code], {
    gamesThis,
    games: poolGames,
    lastSeasonWeight: PRIOR_DEFAULTS.lastSeasonWeight,
    lastSeasonGames: PRIOR_DEFAULTS.lastSeasonGames,
  });
  if (model) pooledCount += 1;
  /* Same Tier 3 rule as Classic, through the same helper — Draft must not grow
     its own historical-data policy. Role only, and only where the Premier
     League has too little to say. */
  const espn = espnHistory?.players?.[p.code] ? espnEvidence(espnHistory.players[p.code], p.element_type) : null;
  const thin = !model || model.evidenceMinutes < PRIOR_DEFAULTS.espnAppliesBelowMinutes;
  if (espn && thin && espn.minutesEvidence > (model?.minutesEvidenceMinutes ?? 0)) {
    if (model) {
      model.modelMinutes = espn.mpg * poolGames;
      model.minutesEvidenceMinutes = espn.minutesEvidence;
    }
    espnApplied += 1;
  }
  return {
    model,
    espn: espn ? { mpg: espn.mpg, minutes: espn.minutes, starts: espn.starts, competitions: espn.competitions } : null,
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

// Real club strength ratings, for js/model.js's teamDefence() fallback when a
// club has too little prior-season data (newly promoted sides). Sourced from
// the live classic payload, never from data/bootstrap.json — that file is
// synthetic seed data regenerated by scripts/make-sample.mjs on every test run.
const teams = (classicBoot.teams || []).map((t) => ({
  id: t.id,
  name: t.name,
  short_name: t.short_name,
  strength_overall_home: num(t.strength_overall_home),
  strength_overall_away: num(t.strength_overall_away),
}));

/* Gameweek deadlines, so Draft season mode can tell which gameweek a waiver
   claim can still affect. The Draft pages read this one file and never load the
   Classic bootstrap, so the deadlines have to travel with the board. Ids and
   deadlines only — nothing else here is a Draft concern. */
const events = (classicBoot.events || []).map((e) => ({
  id: e.id,
  deadline_time: e.deadline_time ?? null,
}));

await writeJSONIfChanged(`${DIR}/players.json`, {
  builtAt: new Date().toISOString(),
  priorSeason: prior.season,
  events,
  players,
  teams,
});
console.log(`✓ ${players.length} players on the board, ${teams.length} teams`);
console.log(`  ${espnApplied} given a role from permitted ESPN 2025/26 evidence`);
console.log(`  ${pooledCount} pooled with this season (${gamesThis} game${gamesThis === 1 ? '' : 's'} played, basis ${poolGames.toFixed(1)})`);

/* ------------------------------------------------------------------ *
 * Live gameweek scoring
 *
 * League-independent and public, so it runs with or without a league id.
 *
 * It must come from the DRAFT live endpoint, not data/live.json: Draft scores
 * under its league's own rules, and the two games disagree on element ids for
 * 21 of 587 players. Keyed on the same id the board above is keyed on
 * (`d?.id ?? p.id`), because that is what the pages join against — the draft
 * element id IS that key for every player the endpoint can return, since a
 * player absent from the Draft game never appears here.
 *
 * Flattened to the fields the dashboard renders, matching data/live.json's
 * slimming, and written as an object keyed by id because that is how
 * dashboard-draft.js reads it: live.elements[p.id].total_points.
 * ------------------------------------------------------------------ */
const game = await getJSON(`${DRAFT_API}/game`, { browserUA: true })
  .catch((e) => { console.warn(`  draft game state failed: ${e.message}`); return null; });
const liveGW = game?.current_event ?? null;

if (!liveGW) {
  console.log('  no current draft gameweek — skipping live scoring');
} else {
  console.log(`→ draft event/${liveGW}/live`);
  const live = await getJSON(`${DRAFT_API}/event/${liveGW}/live`, { browserUA: true })
    .catch((e) => { console.warn(`  draft live failed: ${e.message}`); return null; });

  if (!live?.elements) {
    console.warn('  no live payload — leaving any committed live.json untouched');
  } else {
    const elements = {};
    for (const [id, el] of Object.entries(live.elements)) {
      const s = el.stats || {};
      elements[id] = {
        total_points: num(s.total_points),
        minutes: num(s.minutes),
        goals_scored: num(s.goals_scored),
        assists: num(s.assists),
        clean_sheets: num(s.clean_sheets),
        saves: num(s.saves),
        defensive_contribution: num(s.defensive_contribution),
        bonus: num(s.bonus),
        bps: num(s.bps),
        yellow_cards: num(s.yellow_cards),
        red_cards: num(s.red_cards),
      };
    }
    const playing = Object.values(elements).filter((e) => e.minutes > 0).length;
    await writeJSONIfChanged(`${DIR}/live.json`, {
      event: liveGW,
      fetchedAt: new Date().toISOString(),
      elements,
    });
    console.log(`  GW${liveGW}: ${playing} of ${Object.keys(elements).length} players with minutes`);
  }
}

/* ------------------------------------------------------------------ *
 * Optional: mirror the Draft league
 *
 * Everything above works with no league id, and that stays true — the draft
 * assistant must never require one. This block runs only when
 * FPL_DRAFT_LEAGUE_ID is set, and any failure leaves the committed file alone.
 *
 * What it buys: real manager names instead of "Slot 4", and live ownership so
 * opponent rosters maintain themselves through the season instead of being
 * typed in.
 * ------------------------------------------------------------------ */
const LEAGUE_ID = (process.env.FPL_DRAFT_LEAGUE_ID || '').trim();
// Which of the league's entries is the owner's. The Draft API cannot tell us
// without a login, so it is configured; without it the hub can still show every
// squad, it just cannot mark one of them "you".
const MY_ENTRY_ID = Number(process.env.FPL_DRAFT_ENTRY_ID || 0) || null;

if (!LEAGUE_ID) {
  console.log('  no FPL_DRAFT_LEAGUE_ID — skipping league mirror (this is fine)');
} else {
  console.log(`→ draft league ${LEAGUE_ID}`);

  // Draft element ids are NOT classic element ids — 21 of 587 differ. This is
  // the single most dangerous join in the project, and it is dangerous in both
  // directions: every consumer looks ownership up as `byId.get(elementId)`
  // against a board row, and the board above is keyed on `d?.id ?? p.id` — the
  // DRAFT id wherever the Draft game knows the player. So ownership must be
  // written in that same space, straight off `element_status`, with no
  // translation. It previously translated to classic ids, which silently put
  // two of this league's owned players in the free-agent pool and handed two
  // free agents to managers who did not own them.
  //
  // Keyed by code so the check below can prove the join rather than assume it.
  const boardById = new Map(players.map((p) => [p.id, p]));
  const boardByCode = new Map(players.map((p) => [p.code, p]));
  const draftCodeById = new Map((draftBoot?.elements || []).map((d) => [d.id, d.code]));

  const details = await getJSON(`${DRAFT_API}/league/${LEAGUE_ID}/details`, { browserUA: true })
    .catch((e) => { console.warn(`  league details failed: ${e.message}`); return null; });

  const status = await getJSON(`${DRAFT_API}/league/${LEAGUE_ID}/element-status`, { browserUA: true })
    .catch((e) => { console.warn(`  element-status failed: ${e.message}`); return null; });

  // Round-1 pick order IS the draft slot, so the choices endpoint is what turns
  // an entry id into a slot number. It is empty until the draft starts.
  const choices = await getJSON(`${DRAFT_API}/draft/${LEAGUE_ID}/choices`, { browserUA: true })
    .catch(() => null);

  if (!details?.league) {
    console.warn('  ✗ no league payload — leaving any committed league.json untouched');
  } else {
    const slotByEntry = new Map();
    for (const c of choices?.choices || []) {
      if (c.round === 1 && c.entry != null) slotByEntry.set(c.entry, c.pick);
    }

    const managers = (details.league_entries || []).map((e) => ({
      entryId: e.entry_id ?? e.id ?? null,
      leagueEntryId: e.id ?? null,
      teamName: e.entry_name ?? null,
      manager: [e.player_first_name, e.player_last_name].filter(Boolean).join(' ') || null,
      shortName: e.short_name ?? null,
      slot: slotByEntry.get(e.entry_id ?? e.id) ?? null,
    }));

    // element → owning league entry, in the board's own id space.
    const ownership = {};
    let unresolved = 0;
    let misjoined = 0;
    for (const row of status?.element_status || []) {
      if (row.owner == null) continue;

      // The key actually written, and the footballer it is supposed to mean.
      // `code` is the identity the two games agree on; the key is not. Keeping
      // them as separate variables is the point — the check below validates the
      // key, so reintroducing any translation here trips it instead of silently
      // shipping wrong rosters, which is exactly how this went wrong before.
      const key = row.element;
      const code = draftCodeById.get(row.element);

      const target = boardById.get(key);
      if (!target) { unresolved += 1; continue; }
      if (code != null && target.code !== code) {
        misjoined += 1;
        const should = boardByCode.get(code);
        console.warn(`  ✗ ownership key ${key} resolves to ${target.web_name} but should be `
          + `${should?.web_name ?? `code ${code}`} — the join is broken, dropping it`);
        continue;
      }
      ownership[key] = row.owner;
    }
    if (unresolved) console.warn(`  ${unresolved} owned elements are not on the board`);
    if (misjoined) console.warn(`  ${misjoined} owned elements failed the code check and were dropped`);

    /* ---------------------------------------------------------------- *
     * derive the transaction log
     * ---------------------------------------------------------------- *
     * league/{id}/transactions and draft/{id}/trades both 404 without a
     * login, so the moves themselves are not published. Ownership is, and a
     * change of owner IS a transaction — so the log is built by diffing this
     * refresh against the last committed one and appending what moved.
     *
     * It therefore starts empty and accumulates from the first refresh after
     * this ships. It cannot recover history it never saw, and it should not
     * pretend otherwise.
     */
    const previous = await readJSON(`${DIR}/league.json`).catch(() => null);
    const log = (await readJSON(`${DIR}/transactions.json`).catch(() => null)) || { events: [] };
    if (previous?.ownership && Object.keys(previous.ownership).length) {
      const now = new Date().toISOString();
      const seen = new Set([...Object.keys(previous.ownership), ...Object.keys(ownership)]);
      const fresh = [];
      for (const id of seen) {
        const before = previous.ownership[id] ?? null;
        const after = ownership[id] ?? null;
        if (before === after) continue;
        fresh.push({
          at: now,
          element: Number(id),
          from: before,
          to: after,
          kind: before == null ? 'added' : after == null ? 'dropped' : 'traded',
        });
      }
      if (fresh.length) {
        log.events.push(...fresh);
        // A season of waivers is small, but unbounded growth is still a bug.
        if (log.events.length > 2000) log.events = log.events.slice(-2000);
        console.log(`  ${fresh.length} ownership change${fresh.length === 1 ? '' : 's'} recorded`);
      }
    }
    // Written every run, changes or not, so the page always has a file to read
    // rather than having to treat "missing" and "nothing happened yet" alike.
    log.updatedAt = new Date().toISOString();
    await writeJSONIfChanged(`${DIR}/transactions.json`, log);

    const changed = await writeJSONIfChanged(`${DIR}/league.json`, {
      fetchedAt: new Date().toISOString(),
      leagueId: Number(LEAGUE_ID),
      myEntryId: MY_ENTRY_ID,
      name: details.league.name ?? null,
      size: details.league.max_entries ?? managers.length,
      draftAt: details.league.draft_dt ?? null,
      draftStatus: details.league.draft_status ?? null,
      pickTimeLimit: details.league.draft_pick_time_limit ?? null,
      tradesEnabled: details.league.trades === 'y',
      managers,
      ownership,
      // Provenance, per the Phase 2 brief: every consumer should be able to see
      // where a field came from and how stale it is.
      source: { managers: 'draft-api', ownership: 'draft-api', slots: choices?.choices?.length ? 'draft-api' : 'unknown' },
    });
    console.log(`  ${managers.length} managers, ${Object.keys(ownership).length} owned players${changed ? '' : ' (unchanged)'}`);
  }
}

/* ------------------------------------------------------------------ *
 * 6. my lineup
 * ------------------------------------------------------------------ *
 * Ownership says which fifteen are mine; it does not say which eleven I
 * STARTED, nor the order the bench would come on. Those are a separate
 * endpoint, and without them the app draws a plausible eleven rather than the
 * one on the Draft site — which is the one thing a squad view must never do.
 *
 * `position` 1-11 is the eleven named, 12-15 the bench in substitution order.
 * Element ids here are the DRAFT game's, matching data/draft/players.json;
 * they disagree with classic ids for 21 of 587 players, so this must not be
 * translated. See CLAUDE.md.
 */
if (MY_ENTRY_ID) {
  console.log('→ my Draft lineup');
  const gw = liveGW || 1;
  const mine = await getJSON(`${DRAFT_API}/entry/${MY_ENTRY_ID}/event/${gw}`, { browserUA: true })
    .catch(() => null);
  if (mine?.picks?.length) {
    const changed = await writeJSONIfChanged(`${DIR}/picks.json`, {
      fetchedAt: new Date().toISOString(),
      entryId: MY_ENTRY_ID,
      event: gw,
      picks: mine.picks
        .map((p) => ({ element: p.element, position: p.position }))
        .sort((a, b) => a.position - b.position),
      subs: mine.subs ?? [],
      history: mine.entry_history ?? null,
    });
    console.log(`  ${mine.picks.length} picks for GW${gw}${changed ? '' : ' (unchanged)'}`);
  } else {
    console.log('  no lineup published yet');
  }
}
