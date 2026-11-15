/**
 * Loads the JSON snapshots committed by the refresh workflow.
 * Everything is same-origin, so there is no CORS problem and no API key.
 */
import { hydrate } from './prior.js';

const cache = new Map();

/* Data files are rewritten by a workflow; without a buster GitHub Pages' CDN
   can serve a stale copy for minutes after a refresh.

   The buster used to be the current MINUTE on every file, which made every URL
   new on every page view: moving from the Dashboard to Transfers re-downloaded
   about 2MB (bootstrap, fixtures, the frozen prior) that had not changed. Now
   only the small meta.json is fetched per minute, and everything else is keyed
   on the refresh it reports — so a file is downloaded once per refresh and
   served from the browser cache until the next one. */
const minute = () => Math.floor(Date.now() / 60000);
let metaPromise = null;
function loadMeta() {
  metaPromise ??= fetch(`data/meta.json?v=${minute()}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return metaPromise;
}
/* Files that never change once written keep one URL for good. */
const FROZEN = { 'draft/prior-2526': 'frozen-1' };
async function versionFor(name) {
  if (FROZEN[name]) return FROZEN[name];
  const meta = await loadMeta();
  return meta?.fetched_at ? encodeURIComponent(meta.fetched_at) : String(minute());
}

export async function load(name, fallback = null) {
  if (cache.has(name)) return cache.get(name);
  const p = name === 'meta'
    ? loadMeta().then((m) => m ?? fallback)
    : versionFor(name)
      .then((v) => fetch(`data/${name}.json?v=${v}`))
      .then((r) => (r.ok ? r.json() : fallback))
      .catch(() => fallback);
  cache.set(name, p);
  return p;
}

export async function loadAll() {
  const [meta, rawBoot, fixtures, live, entry, leagues, scoreboard, standings, news, notes, prices, setPieces, prior, espnHistory] =
    await Promise.all([
      load('meta', { source: 'missing' }),
      load('bootstrap'),
      load('fixtures', []),
      load('live', null),
      load('entry', null),
      load('leagues', []),
      load('espn-scoreboard', { events: [] }),
      load('espn-standings', []),
      load('espn-news', []),
      load('manual/season-notes', null),
      load('price-history', { players: {} }),
      load('set-pieces', null),
      // Last season, frozen before FPL zeroed it at the GW1 deadline. Static, so
      // it caches indefinitely. See js/prior.js for why the model needs it.
      load('draft/prior-2526', null),
      // ESPN 2025/26 evidence for players the Premier League has never seen.
      // Optional: absent or stale, the model falls back to its own priors.
      load('espn-history', null),
    ]);
  // Every page projects from the pooled payload. `minutes`, price, ownership and
  // the rest are untouched — the blend only adds the fields js/model.js reads
  // for playing time and confidence, so anything displaying raw data is safe.
  const boot = hydrate(rawBoot, prior, {}, espnHistory);
  return { meta, boot, rawBoot, prior, espnHistory, fixtures, live, entry, leagues, scoreboard, standings, news, notes, prices, setPieces };
}

/** Read one snapshot by name, e.g. 'draft/bootstrap'. */
export async function readSnapshot(name, fallback = null) {
  try {
    /* Same versioning as load(): fresh after every refresh, cached between. */
    const res = await fetch(`data/${name}.json?v=${await versionFor(name)}`);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * local state — your squad, saved in the browser
 * ------------------------------------------------------------------ */
const KEY = 'fpl2627';

export function getState() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export function setState(patch) {
  const next = { ...getState(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* private browsing — settings just won't persist */ }
  return next;
}

/* ------------------------------------------------------------------ *
 * your FPL entry, as it stands NOW rather than at the last deadline
 * ------------------------------------------------------------------ */

/**
 * Transfers already confirmed for the next deadline.
 *
 * `entry.picks` is the squad FPL scored in `picks_event`, and it does not
 * change until the next deadline passes. A transfer made on Tuesday therefore
 * left every page planning from last week's fifteen until Saturday — still
 * recommending the move that had already been made, with last week's bank.
 * `entry.transfers` does carry it, tagged with the gameweek it is for.
 *
 * Only once the picks gameweek is over. While it is still being played those
 * picks are the team on the pitch, and the live view must not swap anyone.
 */
export function pendingTransfers(entry, events = []) {
  const ev = entry?.picks_event;
  if (!ev || !Array.isArray(entry?.transfers)) return [];
  const event = events.find((e) => e.id === ev);
  if (!event?.finished) return [];
  return entry.transfers.filter((t) => t.event > ev)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

/** The fifteen FPL actually scored in `picks_event`, untouched. */
export function fieldedPicks(entry) {
  return entry?.picks?.picks || [];
}

/**
 * The picks with confirmed transfers applied. An incoming player takes the
 * outgoing one's slot — position, bench order and armband — which is exactly
 * what FPL does until the manager rearranges the team.
 */
export function currentPicks(entry, events = []) {
  let picks = fieldedPicks(entry);
  for (const t of pendingTransfers(entry, events)) {
    picks = picks.map((p) => (p.element === t.element_out ? { ...p, element: t.element_in, pending: true } : p));
  }
  return picks;
}

/**
 * Money in the bank, in tenths.
 *
 * A figure typed on the Transfers page wins, but only for the gameweek it was
 * typed in: it used to be remembered for ever, so one edit in September pinned
 * the bank for the season, while the two pages that never read the entry at all
 * planned with nothing. Otherwise it is the bank at the last deadline, moved by
 * whatever has been bought and sold since.
 */
export function resolveBank(entry, state, events = []) {
  const ev = entry?.picks_event ?? null;
  if (state?.bank != null && (ev == null || state.bankEvent === ev)) return state.bank;
  const base = entry?.picks?.entry_history?.bank ?? entry?.entry?.last_deadline_bank;
  if (base == null) return state?.bank ?? 0;
  return pendingTransfers(entry, events)
    .reduce((b, t) => b + (t.element_out_cost ?? 0) - (t.element_in_cost ?? 0), base);
}

/**
 * Free transfers available for the next deadline.
 *
 * One a week, banked to five, spent by each transfer made. Derived from the
 * entry's own history rather than left at 1 — it was 2, 3 and 4 through
 * October while every page still said one. A wildcard or free hit week spends
 * none and banks none. As with the bank, a typed figure wins for its gameweek.
 */
export function resolveFreeTransfers(entry, state, events = []) {
  const ev = entry?.picks_event ?? null;
  if (state?.freeTransfers != null && (ev == null || state.freeTransfersEvent === ev)) return state.freeTransfers;
  const past = entry?.history?.current;
  if (!Array.isArray(past) || !past.length) return state?.freeTransfers ?? 1;
  const chipWeeks = new Set((entry.history.chips || [])
    .filter((c) => c.name === 'wildcard' || c.name === 'freehit').map((c) => c.event));
  let ft = 1;                                   // what you hold going into GW2
  for (const h of [...past].sort((a, b) => a.event - b.event)) {
    if (h.event === past[0].event && h.event === entry.entry?.started_event) continue; // no transfers before the first team
    if (chipWeeks.has(h.event)) continue;
    ft = Math.min(5, Math.max(0, ft - (h.event_transfers || 0)) + 1);
  }
  return Math.max(0, ft - pendingTransfers(entry, events).length);
}

/**
 * What each owned player would actually sell for, in tenths.
 *
 * FPL keeps half of any rise, rounded down: bought at 6.3 and now 6.7, he sells
 * for 6.5. Planning on `now_cost` overstated this squad's sale value by £1.2m
 * and listed moves that could not be afforded. The purchase price is the latest
 * recorded buy, or the start-of-season price for anyone held since the first
 * squad.
 */
export function sellPrices(entry, elements = [], events = []) {
  const bought = new Map();
  for (const t of [...(entry?.transfers || [])].sort((a, b) => String(a.time).localeCompare(String(b.time)))) {
    bought.set(t.element_in, t.element_in_cost);
  }
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = new Map();
  for (const pick of currentPicks(entry, events)) {
    const e = byId.get(pick.element);
    if (!e) continue;
    const buy = bought.get(e.id) ?? (e.now_cost - (e.cost_change_start ?? 0));
    out.set(e.id, e.now_cost > buy ? buy + Math.floor((e.now_cost - buy) / 2) : e.now_cost);
  }
  return out;
}

/**
 * Which fifteen to show.
 *
 * Your REAL picks win once FPL publishes them. A saved squad used to take
 * precedence unconditionally, which was right before the first deadline — when
 * picks do not exist yet and a planned squad is all there is — and wrong
 * immediately after, when it meant the Dashboard showed a stale plan while your
 * actual team scored points, with no control anywhere in the app to clear it.
 *
 * `preferManual` is the escape hatch: set it and a saved squad wins again, for
 * planning a wildcard or a future gameweek. It is explicit, and it is
 * reversible.
 *
 * Pass `events` and transfers already confirmed for the next deadline are
 * applied; see pendingTransfers.
 */
export function resolveSquadIds(entry, state, events = []) {
  const picks = currentPicks(entry, events);
  const manual = state?.manualSquad || [];
  if (state?.preferManual && manual.length === 15) return { ids: manual, source: 'manual' };
  if (picks?.length) return { ids: picks.map((p) => p.element), source: 'fpl' };
  if (manual.length === 15) return { ids: manual, source: 'manual' };
  if (manual.length) return { ids: manual, source: 'manual-partial' };
  return { ids: [], source: 'none' };
}


/**
 * A finished gameweek, as it was.
 *
 * `projected` is what the model said before that deadline; `actual` is what the
 * player scored. They are stored together by scripts/archive-gameweek.mjs so
 * the comparison is honest — recomputing a projection after the fact would use
 * evidence that did not exist at the time, and FPL wipes the season totals at
 * the deadline anyway, so the recomputed number is a different quantity.
 *
 * @returns {Promise<{event:number, projected:object, actual:object}|null>}
 */
export async function readGameweek(n) {
  const g = await load(`history/gw/${n}`, null);
  return g?.event ? g : null;
}

/** Which gameweeks have something archived, newest first. */
export async function archivedGameweeks(events = []) {
  const found = [];
  for (const ev of events) {
    const g = await readGameweek(ev.id);
    if (g?.actual) found.push(ev.id);
  }
  return found.sort((a, b) => b - a);
}
