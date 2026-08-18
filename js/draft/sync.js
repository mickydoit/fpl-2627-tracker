/**
 * Cross-device draft sync.
 *
 * The design rule that matters: **localStorage stays authoritative.** Supabase
 * is a mirror, never the source of truth. If the network is slow, the project
 * is down, or the keys are missing, every call here fails quietly and the draft
 * carries on exactly as it did before. Nothing on draft night may block on a
 * round-trip while a pick clock is running.
 *
 * There is no sign-in, so there is no per-user row — one well-known row is the
 * board, and whichever device wrote last wins. That is the correct behaviour
 * for one person moving between a laptop and a phone, and the wrong behaviour
 * for two people drafting at once, which this is not for.
 */
import { SUPABASE } from './config.js';

const ROW_ID = 'fpl-2627-draft';
const TABLE = 'draft_state';
const TIMEOUT_MS = 4000;

/**
 * A dev copy must never write to the live board.
 *
 * There is one well-known row, so a mock draft served from localhost would
 * otherwise push straight over the real one — and a device that later opens the
 * deployed site would adopt those picks, because all it compares is which board
 * has more of them. Running the page locally is therefore read-and-write-nothing.
 */
const isLocalhost = typeof location !== 'undefined'
  && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/** Sync is entirely optional — without keys the app behaves as it always did. */
export function syncConfigured() {
  return Boolean(!isLocalhost && SUPABASE?.url && SUPABASE?.anonKey);
}

function endpoint(query = '') {
  return `${SUPABASE.url}/rest/v1/${TABLE}${query}`;
}

function headers(extra = {}) {
  return {
    apikey: SUPABASE.anonKey,
    Authorization: `Bearer ${SUPABASE.anonKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Every network call is time-boxed; a hanging request must not stall a pick. */
async function withTimeout(run) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the shared board.
 * @returns {Promise<{state: object, updatedAt: string, device: string}|null>}
 *   null when sync is off, the row does not exist yet, or anything failed.
 */
export async function pull() {
  if (!syncConfigured()) return null;
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(
        endpoint(`?id=eq.${ROW_ID}&select=state,updated_at,device`),
        { headers: headers(), signal },
      );
      if (!res.ok) return null;
      const rows = await res.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row?.state) return null;
      return { state: row.state, updatedAt: row.updated_at, device: row.device || '' };
    });
  } catch {
    return null;
  }
}

/**
 * Mirror the local draft upward. Resolves to true only on a confirmed write, so
 * the caller can show an honest status rather than implying a save that never
 * happened.
 */
export async function push(state, device = deviceName()) {
  if (!syncConfigured() || !state) return false;
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(endpoint('?on_conflict=id'), {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ id: ROW_ID, state, device }]),
        signal,
      });
      return res.ok;
    });
  } catch {
    return false;
  }
}

/**
 * Coalesce bursts of picks into one write. Entering five picks quickly should
 * cost one request, not five, and the local save has already happened by then.
 */
export function debouncedPush(wait = 1200) {
  let timer = null;
  let pending = null;
  return (state) => {
    pending = state;
    clearTimeout(timer);
    timer = setTimeout(() => { push(pending); pending = null; }, wait);
  };
}

/** A human-readable hint of where a draft was last touched. */
export function deviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone|Android.*Mobile/i.test(ua)) return 'phone';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  return 'laptop';
}
