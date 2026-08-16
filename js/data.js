/**
 * Loads the JSON snapshots committed by the refresh workflow.
 * Everything is same-origin, so there is no CORS problem and no API key.
 */

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
  const [meta, boot, fixtures, live, entry, leagues, scoreboard, standings, news, notes, prices, setPieces] =
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
    ]);
  return { meta, boot, fixtures, live, entry, leagues, scoreboard, standings, news, notes, prices, setPieces };
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
export function resolveSquadIds(entry, state) {
  if (state?.manualSquad?.length === 15) return { ids: state.manualSquad, source: 'manual' };
  const picks = entry?.picks?.picks;
  if (picks?.length) return { ids: picks.map((p) => p.element), source: 'fpl' };
  if (state?.manualSquad?.length) return { ids: state.manualSquad, source: 'manual-partial' };
  return { ids: [], source: 'none' };
}
