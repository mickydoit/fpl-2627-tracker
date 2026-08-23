/**
 * Loads the JSON snapshots committed by the refresh workflow.
 * Everything is same-origin, so there is no CORS problem and no API key.
 */
import { hydrate } from './prior.js';

const cache = new Map();

// Data files are rewritten by a workflow; without a buster GitHub Pages' CDN
// can serve a stale copy for minutes after a refresh.
function bust() {
  const m = Math.floor(Date.now() / 60000);
  return `?v=${m}`;
}

export async function load(name, fallback = null) {
  if (cache.has(name)) return cache.get(name);
  const p = fetch(`data/${name}.json${bust()}`)
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
    const res = await fetch(`data/${name}.json`, { cache: 'no-store' });
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

/**
 * Your 15. Prefers the squad the workflow pulled from your FPL entry id;
 * falls back to whatever you picked manually in the optimiser.
 */
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
 */
export function resolveSquadIds(entry, state) {
  const picks = entry?.picks?.picks;
  const manual = state?.manualSquad || [];
  if (state?.preferManual && manual.length === 15) return { ids: manual, source: 'manual' };
  if (picks?.length) return { ids: picks.map((p) => p.element), source: 'fpl' };
  if (manual.length === 15) return { ids: manual, source: 'manual' };
  if (manual.length) return { ids: manual, source: 'manual-partial' };
  return { ids: [], source: 'none' };
}
