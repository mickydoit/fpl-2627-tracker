// Shared HTTP helper: retries, backoff, descriptive UA, JSON validation.
// Runs on GitHub Actions runners (server-side), which is required because the
// FPL API sends no Access-Control-Allow-Origin and sets
// Cross-Origin-Resource-Policy: same-origin — browsers cannot read it directly.

const UA =
  'fpl-2627-tracker/1.0 (+https://github.com/mickydoit/fpl-2627-tracker) node-fetch';

// ESPN's site.api.espn.com sits behind Akamai and rejects unrecognised
// user-agents and HEAD requests, so we present a browser-like UA there.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJSON(url, { retries = 4, browserUA = false, timeout = 30000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      console.warn(`  retry ${attempt}/${retries} in ${backoff}ms — ${url}`);
      await sleep(backoff);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': browserUA ? BROWSER_UA : UA,
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-GB,en;q=0.9',
          // Additional headers last, so an authenticated source can supply its
          // own token without the defaults above overwriting it.
          ...headers,
        },
      });
      if (res.status === 404) return null; // expected for not-yet-existing GW resources
      // 429 means we are being told to slow down, not that the resource is
      // broken. Honour Retry-After when it is offered rather than hammering
      // through the normal backoff ladder.
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after')) || 60;
        console.warn(`  rate limited, waiting ${wait}s — ${url}`);
        await sleep(wait * 1000);
        throw new Error('HTTP 429 rate limited');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Failed after ${retries} retries: ${url} — ${lastErr?.message}`);
}

/**
 * An ESPN scoreboard over a span of dates.
 *
 * ESPN stopped serving `dates=YYYYMMDD-YYYYMMDD` in mid-September 2026: every
 * range, however short, now answers 400 "Failed to get events endpoint". The
 * failure was quiet everywhere it mattered — the live scoreboard stopped
 * updating on 15 September, the match collector found no fixture list, and the
 * warehouse spent most of each 43-minute run backing off against requests that
 * could not succeed.
 *
 * A whole calendar year (`dates=YYYY`) and a single day are still served, so a
 * span is fetched as the one or two years it touches and trimmed to the dates
 * asked for. A season costs two requests instead of one.
 *
 * @param {string} base  e.g. .../sports/soccer/eng.1  (no trailing /scoreboard)
 * @param {string} from  YYYYMMDD, inclusive
 * @param {string} to    YYYYMMDD, inclusive
 */
export async function espnScoreboard(base, from, to, opts = {}) {
  const ymd = (iso) => String(iso || '').slice(0, 10).replace(/-/g, '');
  const merged = { events: [] };
  const seen = new Set();
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    const page = await getJSON(`${base}/scoreboard?dates=${year}&limit=1000`, { browserUA: true, ...opts });
    if (!Array.isArray(page?.events)) throw new Error(`ESPN scoreboard ${year}: no events array`);
    if (!merged.leagues) Object.assign(merged, { ...page, events: merged.events });
    for (const ev of page.events) {
      const day = ymd(ev.date);
      if (day < from || day > to || seen.has(ev.id)) continue;
      seen.add(ev.id);
      merged.events.push(ev);
    }
  }
  merged.events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return merged;
}

// Politeness throttle for the ~700-request element-summary sweep.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      await sleep(120);
    }
  });
  await Promise.all(workers);
  return out;
}
