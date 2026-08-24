import { loadAll, getState, setState, resolveSquadIds } from '../data.js';
import { projectAll, POS, SQUAD_RULES } from '../model.js';
import { bestXI, scoreSquad, legalXI } from '../optimiser.js';
import { squadPitch, playerCard, enableSwapping, activityRings } from '../squadview.js';
import { horizonPicker, SEASON_HORIZON } from '../ui.js';
import { rateSquad, RATING_HORIZONS } from '../rating.js';
import { $, el, fmt, dataBar, countdown, statusBadge, posPill, modal, breakdown , setKids, addKids} from '../ui.js';

/**
 * The Dashboard hosts two products behind a tab strip: your Classic FPL team
 * and your Draft team. They share this shell and nothing else — the Classic
 * half below is untouched and still renders into `app`, which is now an inner
 * container rather than the page root.
 *
 * The Draft half is imported lazily, so a Classic-only user never downloads it
 * and a broken Draft dataset can never stop the Classic dashboard rendering.
 */
const root = $('#app');
const app = el('div', { class: 'mode-classic' });
const draftHost = el('div', { class: 'mode-draft', style: 'display:none' });

let mode = (() => {
  try { return localStorage.getItem('dashboardMode') || 'classic'; } catch { return 'classic'; }
})();
let draftLoaded = false;

const tabBtn = (id, label) => el('button', {
  class: mode === id ? 'on' : '',
  type: 'button',
  onClick: () => setMode(id),
}, label);

const tabs = el('div', { class: 'modetabs' }, tabBtn('classic', 'FPL Classic'), tabBtn('draft', 'Draft'));

async function setMode(next) {
  mode = next;
  try { localStorage.setItem('dashboardMode', next); } catch { /* private mode */ }
  [...tabs.children].forEach((b, i) => b.classList.toggle('on', (i === 0) === (next === 'classic')));
  app.style.display = next === 'classic' ? '' : 'none';
  draftHost.style.display = next === 'draft' ? '' : 'none';
  if (next === 'draft' && !draftLoaded) {
    draftLoaded = true;
    setKids(draftHost, el('p', { class: 'loading' }, 'Loading your Draft team…'));
    try {
      // Inherit this page's cache-busting version so the lazy half cannot go
      // stale while the eager half updates.
      const v = new URL(import.meta.url).searchParams.get('v');
      const { renderDraftDashboard } = await import(`./dashboard-draft.js${v ? `?v=${v}` : ''}`);
      await renderDraftDashboard(draftHost);
    } catch (err) {
      draftLoaded = false;
      setKids(draftHost, el('p', { class: 'empty' }, `Draft dashboard unavailable: ${err.message}`));
    }
  }
}

setKids(root, tabs, app, draftHost);
if (mode === 'draft') setMode('draft');
const d = await loadAll();
$('#databar').replaceWith(dataBar(d.meta));

if (!d.boot) {
  setKids(app, 
    el('div', { class: 'card' },
      el('h2', {}, 'No data yet'),
      el('p', {}, 'The site is deployed but no snapshot has been committed. Open the Actions tab in your repo and run the '),
      el('p', {}, el('strong', {}, '“Refresh FPL data”'), ' workflow. It takes about a minute and commits the FPL and ESPN data into data/.'),
      el('p', { class: 'hint' }, 'Set the FPL_ENTRY_ID repository variable first if you want My Team and mini-league tracking.'),
    ),
  );
  throw new Error('no data');
}

const state = getState();
const horizon = state.horizon ?? 5;
const { rows, ctx } = projectAll(d.boot, d.fixtures, { horizon });
const byId = new Map(rows.map((p) => [p.id, p]));
const teams = ctx.teams;

/* ------------------------------------------------------------------ *
 * headline tiles
 * ------------------------------------------------------------------ */
const nextEvent = d.boot.events.find((e) => e.id === ctx.nextEvent);
const currentEvent = d.boot.events.find((e) => e.is_current);
const entry = d.entry?.entry;

const tiles = el('div', { class: 'tiles' });

const cdTile = el('div', { class: 'tile accent' },
  el('span', { class: 'k' }, `GW${ctx.nextEvent} deadline`),
  el('span', { class: 'v countdown' }, '—'),
  el('span', { class: 's' }, nextEvent?.deadline_time
    ? new Date(nextEvent.deadline_time).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'unknown'),
);
addKids(tiles, cdTile);
countdown(cdTile.querySelector('.countdown'), nextEvent?.deadline_time);

if (entry) {
  addKids(tiles, 
    el('div', { class: 'tile' },
      el('span', { class: 'k' }, 'Overall points'),
      el('span', { class: 'v' }, entry.summary_overall_points ?? '—'),
      el('span', { class: 's' }, entry.name || ''),
    ),
    el('div', { class: 'tile' },
      el('span', { class: 'k' }, 'Overall rank'),
      el('span', { class: 'v' }, entry.summary_overall_rank ? entry.summary_overall_rank.toLocaleString('en-GB') : '—'),
      el('span', { class: 's' }, d.meta?.total_players ? `of ${d.meta.total_players.toLocaleString('en-GB')}` : ''),
    ),
    el('div', { class: 'tile' },
      el('span', { class: 'k' }, 'Squad value'),
      el('span', { class: 'v' }, entry.last_deadline_value ? fmt.price(entry.last_deadline_value) : '—'),
      el('span', { class: 's' }, entry.last_deadline_bank !== undefined ? `${fmt.price(entry.last_deadline_bank)} in the bank` : ''),
    ),
  );
} else {
  addKids(tiles, 
    el('div', { class: 'tile' },
      el('span', { class: 'k' }, 'My team'),
      el('span', { class: 'v' }, '—'),
      el('span', { class: 's' }, 'Set FPL_ENTRY_ID to track it'),
    ),
  );
}
setKids(app, tiles);

/* ------------------------------------------------------------------ *
 * my squad — live or projected
 * ------------------------------------------------------------------ */
const { ids: squadIds, source: squadSource } = resolveSquadIds(d.entry, state);
const liveById = new Map((d.live?.elements || []).map((e) => [e.id, e]));
const isLiveGW = !!currentEvent && !!d.live?.elements?.length;

if (squadIds.length === 15) {
  const squad = squadIds.map((id) => byId.get(id)).filter(Boolean);
  const picks = d.entry?.picks?.picks || [];
  const pickMap = new Map(picks.map((p) => [p.element, p]));

  let xi, bench, captain;
  if (picks.length) {
    // Use the real team you actually submitted, not the model's preferred XI.
    xi = picks.filter((p) => p.position <= 11).map((p) => byId.get(p.element)).filter(Boolean);
    bench = picks.filter((p) => p.position > 11).map((p) => byId.get(p.element)).filter(Boolean);
    captain = byId.get(picks.find((p) => p.is_captain)?.element);
  } else {
    ({ xi, bench, captain } = bestXI(squad));
  }

  const livePts = (p) => {
    const l = liveById.get(p.id);
    if (!l) return null;
    const mult = pickMap.get(p.id)?.multiplier ?? (p === captain ? 2 : 1);
    return l.total_points * (mult || 1);
  };

  const total = isLiveGW
    ? xi.reduce((s, p) => s + (livePts(p) ?? 0), 0)
    : xi.reduce((s, p) => s + p.projPerGW, 0) + (captain?.projPerGW || 0);

  const head = el('div', { class: 'row between' },
    el('h2', {}, isLiveGW ? `GW${currentEvent.id} live` : `GW${ctx.nextEvent} projected`),
    el('span', { class: 'small dim' }, squadSource === 'fpl' ? 'from your FPL team' : 'from your saved squad'),
  );


  /**
   * Your XI is yours to set here too.
   *
   * The page shows the eleven you actually submitted when FPL has published
   * picks, and the model's preferred eleven before that — but either way you
   * may want to try a change and see what it costs. Stored in Classic state,
   * under its own key, and never read by anything in Draft.
   *
   * A live gameweek is the one time this is locked: once players are scoring,
   * rearranging a lineup you can no longer change would be fiction.
   */
  const MY_XI_KEY = 'myXi';
  /**
   * The strongest eleven FOR THE NEXT GAMEWEEK.
   *
   * bestXI ranks on `proj`, which here is the five-gameweek projection — the
   * right basis for judging a squad and the wrong one for choosing a lineup.
   * Starting the player who is better over five weeks rather than the one with
   * the easier fixture on Saturday is a real cost, every week.
   *
   * Squad-level numbers above still use the longer horizon, because "how good
   * is this squad" and "who plays this week" are different questions.
   */
  const LINEUP_HZ = 'lineupHorizon';
  let lineupH = getState()[LINEUP_HZ] ?? 1;
  const hzCache = new Map();
  const valuesAt = (h) => {
    if (!hzCache.has(h)) {
      const rows = projectAll(d.boot, d.fixtures, { horizon: h, riskAversion: state.riskAversion ?? 0.5 }).rows;
      hzCache.set(h, new Map(rows.map((r) => [r.id, r.proj])));
    }
    return hzCache.get(h);
  };
  let byGw = (p) => valuesAt(lineupH).get(p.id) ?? p.projPerGW ?? 0;
  let optimalClassic = bestXI(squad.map((p) => ({ ...p, proj: byGw(p) })));
  let chosenXi = xi.map((p) => p.id);
  if (!isLiveGW) {
    const saved = getState()[MY_XI_KEY];
    if (Array.isArray(saved) && saved.length === 11) {
      const rows = saved.map((id) => byId.get(id)).filter(Boolean);
      if (rows.length === 11 && legalXI(rows) && rows.every((r) => squad.includes(r))) {
        chosenXi = saved;
      }
    }
  }

  const squadCard = el('div', { class: 'card' });
  const paintClassicSquad = () => {
    const curXi = chosenXi.map((id) => byId.get(id)).filter(Boolean);
    const curBench = squad.filter((p) => !chosenXi.includes(p.id));
    const cap = curXi.includes(captain) ? captain : null;
    const projTotal = curXi.reduce((t, p) => t + byGw(p), 0) + (cap ? byGw(cap) : 0);
    const liveTotal = curXi.reduce((t, p) => t + (livePts(p) ?? 0), 0);
    const optTotal = optimalClassic.xi.reduce((t, p) => t + byGw(p), 0)
      + (optimalClassic.captain ? byGw(optimalClassic.captain) : 0);
    const lost = optTotal - projTotal;

    const pitch = squadPitch({
      xi: curXi, bench: curBench, teams, captain: cap,
      value: (p) => fmt.pts(isLiveGW ? (livePts(p) ?? 0) : byGw(p) * (p === cap ? 2 : 1)),
      sub: (p) => (isLiveGW && liveById.get(p.id) ? `${liveById.get(p.id).minutes}'` : fmt.price(p.now_cost)),
      onPlayer: showPlayer,
    });

    setKids(squadCard,
      head,
      el('div', { class: 'row between', style: 'margin-bottom:var(--s-sm)' },
        el('span', { class: 'hint' }, isLiveGW ? 'Live scoring' : 'Lineup decision'),
        isLiveGW ? null : horizonPicker(lineupH, (n) => {
          lineupH = n;
          setState({ [LINEUP_HZ]: n });
          byGw = (p) => valuesAt(lineupH).get(p.id) ?? p.projPerGW ?? 0;
          optimalClassic = bestXI(squad.map((p) => ({ ...p, proj: byGw(p) })));
          paintClassicSquad();
        })),
      el('div', { class: 'tiles' },
        el('div', { class: 'tile accent' },
          el('span', { class: 'k' }, isLiveGW ? 'Live points' : 'Projected points'),
          el('span', { class: 'v' }, fmt.pts(isLiveGW ? liveTotal : projTotal)),
          el('span', { class: 's' }, isLiveGW ? 'includes provisional bonus once official' : `captain: ${cap?.web_name || '—'}`)),
        el('div', { class: 'tile' },
          el('span', { class: 'k' }, `Next ${horizon} GWs`),
          el('span', { class: 'v' }, fmt.pts(scoreSquad(squad, { horizon }))),
          el('span', { class: 's' }, 'XI + captain + weighted bench')),
        isLiveGW
          ? el('div', { class: 'tile' },
            el('span', { class: 'k' }, 'Flagged players'),
            el('span', { class: 'v' }, squad.filter((p) => p.status !== 'a').length),
            el('span', { class: 's' }, squad.filter((p) => p.status !== 'a').map((p) => p.web_name).join(', ') || 'all fit'))
          : el('div', { class: `tile ${lost > 0.05 ? 'warn' : ''}` },
            el('span', { class: 'k' }, 'On your bench'),
            el('span', { class: 'v' }, lost > 0.05 ? `−${lost.toFixed(1)}` : '0.0'),
            el('span', { class: 's' }, lost > 0.05 ? 'points left out of the XI' : 'you are playing the optimum')),
      ),
      isLiveGW
        ? el('p', { class: 'hint' }, 'The gameweek is live, so the lineup is fixed.')
        : el('p', { class: 'hint' }, `Ranked by projected points over ${lineupH === 1 ? 'the next gameweek' : `the next ${lineupH} gameweeks`}`
          + ' — change the window top right. Drag a player onto another to swap them; hold to lift on a phone.'),
      pitch,
      !isLiveGW && lost > 0.05
        ? el('button', { class: 'ghost', onClick: () => {
          chosenXi = optimalClassic.xi.map((p) => p.id);
          setState({ [MY_XI_KEY]: chosenXi });
          paintClassicSquad();
        } }, 'Reset to the strongest XI')
        : null,
    );

    if (isLiveGW) return;
    enableSwapping(pitch, {
      legal: (aId, bId) => {
        const inXi = (id) => chosenXi.includes(id);
        if (inXi(aId) === inXi(bId)) return false;
        const next = chosenXi.map((id) => (id === aId ? bId : id === bId ? aId : id));
        return legalXI(next.map((id) => byId.get(id)).filter(Boolean));
      },
      onSwap: (aId, bId) => {
        chosenXi = chosenXi.map((id) => (id === aId ? bId : id === bId ? aId : id));
        setState({ [MY_XI_KEY]: chosenXi });
        paintClassicSquad();
      },
    });
  };
  paintClassicSquad();

  /* ------------------------------------------------------------------ *
   * where this squad sits
   * ------------------------------------------------------------------ *
   * The Draft tab answers this by ranking you against five rivals. Classic
   * cannot: scripts/fetch-all.mjs pulls your picks and nobody else's, so there
   * are no rival squads to rank against — only their scores, which is a
   * different thing. So the Classic question is the one js/rating.js was built
   * for: how much of what your money could buy are you actually getting,
   * measured against the optimiser's best legal squad at the same spend.
   *
   * The window is the reader's to choose, and it excludes the one-gameweek
   * option Draft offers. RATING_HORIZONS in js/rating.js records why.
   */
  const RATING_HZ = 'ratingHorizon';
  let ratingH = RATING_HORIZONS.includes(getState()[RATING_HZ]) ? getState()[RATING_HZ] : 5;
  const ratingBank = state.bank ?? 0;
  const ratingFT = state.freeTransfers ?? 1;
  const ratingCache = new Map();
  const ratingRowsAt = (h) => {
    if (!ratingCache.has(h)) {
      ratingCache.set(h, projectAll(d.boot, d.fixtures,
        { horizon: h, riskAversion: state.riskAversion ?? 0.5 }).rows);
    }
    return ratingCache.get(h);
  };

  const ratingCard = el('div', { class: 'card' });
  /* Each repaint claims a token. A slow rate that finishes after the reader has
     already moved the picker again must not overwrite the newer one. */
  let ratingRun = 0;
  const paintRating = () => {
    const mine = ++ratingRun;
    const windowLabel = ratingH >= SEASON_HORIZON ? 'the whole season' : `the next ${ratingH} gameweeks`;
    const head = el('div', { class: 'row between' }, el('h2', {}, 'Squad rating'),
      horizonPicker(ratingH, (n) => {
        ratingH = n;
        setState({ [RATING_HZ]: n });
        paintRating();
      }, { options: RATING_HORIZONS }));

    setKids(ratingCard, head, el('p', { class: 'hint' }, `Rating over ${windowLabel}…`));

    /* Rating runs the optimiser to build the ceiling — a few hundred
       milliseconds. Yield first so the picker repaints immediately rather than
       freezing under the reader's click. */
    setTimeout(() => {
      if (mine !== ratingRun) return;
      const rows = ratingRowsAt(ratingH);
      const atH = new Map(rows.map((r) => [r.id, r]));
      const squadAtH = squad.map((p) => atH.get(p.id)).filter(Boolean);
      const r = squadAtH.length === SQUAD_RULES.size
        ? rateSquad(squadAtH, { pool: rows, bank: ratingBank, freeTransfers: ratingFT })
        : { error: `Only ${squadAtH.length} of your ${SQUAD_RULES.size} players resolved at this window.` };
      if (mine !== ratingRun) return;
      if (r.error) {
        setKids(ratingCard, head, el('p', { class: 'empty' }, r.error));
        return;
      }
      const parts = r.parts;
      setKids(ratingCard, head,
        el('p', { class: 'hint' },
          `How much of what your money could buy you are actually getting, over ${windowLabel}. `
          + `Strongest: ${r.strongest.label} (${r.strongest.score}). `
          + `Weakest: ${r.weakest.label} (${r.weakest.score}).`),
        el('div', { class: 'dd-head' },
          activityRings(
            [
              { label: 'Overall', value: r.overall, max: 100, colour: 'var(--lime, #9fed00)', detail: `of 100` },
              { label: 'Best XI', value: r.dims.xi, max: 100, colour: 'var(--cyan, #8bffec)', detail: `${r.dims.xi}` },
              { label: 'Depth', value: r.dims.depth, max: 100, colour: 'var(--yellow, #f4ff7b)', detail: `${r.dims.depth}` },
            ],
            { value: String(r.overall), caption: 'rating' },
          ),
          el('div', { class: 'tiles dd-tiles' },
            el('div', { class: 'tile accent' },
              el('span', { class: 'k' }, 'Your projection'),
              el('span', { class: 'v' }, fmt.pts(parts.xiPts + parts.capPts)),
              el('span', { class: 's' }, 'best XI, captain doubled')),
            el('div', { class: 'tile' },
              el('span', { class: 'k' }, 'Achievable ceiling'),
              el('span', { class: 'v' }, fmt.pts(parts.bestXiPts + parts.bestCapPts)),
              el('span', { class: 's' }, `the best legal squad at ${fmt.price(parts.budget)}`)),
            el('div', { class: 'tile' },
              el('span', { class: 'k' }, 'Captain'),
              el('span', { class: 'v' }, parts.captain ? parts.captain.web_name : '—'),
              el('span', { class: 's' }, parts.captain ? `${fmt.pts(parts.capPts)} over the window` : '')),
          ),
        ),
      );
    }, 0);
  };
  paintRating();
  addKids(app, ratingCard);

  addKids(app, squadCard);
} else {
  addKids(app, 
    el('div', { class: 'card' },
      el('h2', {}, 'No squad yet'),
      // Three different situations used to share one message telling you to set
      // a variable you may already have set. FPL does not publish picks until
      // the first deadline passes, so between registering a team and GW1 the
      // entry resolves, the NAME is known, and the squad is legitimately empty.
      // Saying "go set the variable" there is wrong and wastes the reader's time.
      d.entry?.entry?.name
        ? el('p', {},
          'Your team ', el('strong', {}, d.entry.entry.name), ' is connected, but FPL does not publish ',
          'picks until the first deadline passes. It will appear here once GW1 locks. ',
          'Until then you can plan one on the ', el('a', { href: 'squad.html' }, 'Squad'), ' page.',
        )
        : el('p', {},
          'Set the ', el('code', {}, 'FPL_ENTRY_ID'), ' repository variable to pull your real team automatically, ',
          'or build one on the ', el('a', { href: 'squad.html' }, 'Squad'), ' page and save it to this browser.',
        ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * live matches (ESPN)
 * ------------------------------------------------------------------ */
const matches = (d.scoreboard?.events || [])
  .filter((m) => {
    const t = new Date(m.date).getTime();
    return t > Date.now() - 3 * 864e5 && t < Date.now() + 8 * 864e5;
  })
  .sort((a, b) => new Date(a.date) - new Date(b.date))
  .slice(0, 12);

if (matches.length) {
  const wrap = el('div', { class: 'matches' });
  for (const m of matches) {
    const cls = m.state === 'in' ? 'live' : m.state === 'post' ? 'done' : '';
    addKids(wrap, 
      el('div', { class: `match ${cls}` },
        el('div', { class: 't h' }, m.home.logo ? el('img', { src: m.home.logo, alt: '', loading: 'lazy' }) : null, m.home.short || m.home.name),
        el('div', { class: 'sc' },
          m.state === 'pre'
            ? new Date(m.date).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
            : `${m.home.score ?? 0} – ${m.away.score ?? 0}`,
          el('span', { class: 'st' }, m.state === 'in' ? (m.clock || 'LIVE') : m.state === 'post' ? 'FT' : ''),
        ),
        el('div', { class: 't a' }, m.away.logo ? el('img', { src: m.away.logo, alt: '', loading: 'lazy' }) : null, m.away.short || m.away.name),
      ),
    );
  }
  addKids(app, el('div', { class: 'card' }, el('h2', {}, 'Matches'), wrap));
}

/* ------------------------------------------------------------------ *
 * price movers
 * ------------------------------------------------------------------ */
const risers = rows.filter((p) => p.cost_change_event > 0).sort((a, b) => b.cost_change_event - a.cost_change_event).slice(0, 8);
const fallers = rows.filter((p) => p.cost_change_event < 0).sort((a, b) => a.cost_change_event - b.cost_change_event).slice(0, 8);
const transfersIn = [...rows].sort((a, b) => b.transfers_in_event - a.transfers_in_event).slice(0, 8);

const moverList = (items, render) =>
  el('ul', { class: 'mover-list' }, items.map((p) => el('li', {}, el('span', {}, p.web_name), render(p))));

if (risers.length || fallers.length || transfersIn.length) {
  addKids(app, 
    el('div', { class: 'card' },
      el('h2', {}, 'Market movement this gameweek'),
      el('div', { class: 'movers' },
        el('div', {},
          el('h3', { class: 'small dim' }, 'Price risers'),
          risers.length ? moverList(risers, (p) => el('span', { class: 'up' }, `+£${(p.cost_change_event / 10).toFixed(1)}m`)) : el('p', { class: 'empty' }, 'None'),
        ),
        el('div', {},
          el('h3', { class: 'small dim' }, 'Price fallers'),
          fallers.length ? moverList(fallers, (p) => el('span', { class: 'down' }, `£${(p.cost_change_event / 10).toFixed(1)}m`)) : el('p', { class: 'empty' }, 'None'),
        ),
        el('div', {},
          el('h3', { class: 'small dim' }, 'Most transferred in'),
          moverList(transfersIn, (p) => el('span', { class: 'dim' }, p.transfers_in_event.toLocaleString('en-GB'))),
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * best value right now
 * ------------------------------------------------------------------ */
const picks = [...rows]
  .filter((p) => p.status === 'a' && p.proj > 0)
  .sort((a, b) => b.value - a.value)
  .slice(0, 10);

addKids(app, 
  el('div', { class: 'card' },
    el('h2', {}, `Best value over the next ${horizon} gameweeks`),
    el('p', { class: 'hint' }, 'Projected points per £1.0m. Click any player for the full breakdown.'),
    el('ul', { class: 'mover-list' }, picks.map((p) =>
      el('li', { style: 'cursor:pointer', onClick: () => showPlayer(p) },
        el('span', {}, posPill(p), ' ', p.web_name, el('span', { class: 'dim small' }, ` ${teams[p.team]?.short_name}`)),
        el('span', {}, el('span', { class: 'dim small' }, `${fmt.price(p.now_cost)} · `), el('strong', {}, fmt.pts(p.proj))),
      ),
    )),
  ),
);

/* ------------------------------------------------------------------ *
 * watchlist from curated research
 * ------------------------------------------------------------------ */
if (d.notes?.watchlist?.length) {
  addKids(app, 
    el('div', { class: 'card' },
      el('h2', {}, 'Season watchlist'),
      el('ul', {}, d.notes.watchlist.map((w) => el('li', { style: 'margin:0.35rem 0' }, w))),
      el('p', { class: 'hint' }, el('a', { href: 'market.html' }, 'Full market and manager notes →')),
    ),
  );
}

/* ------------------------------------------------------------------ */
/** A player's upcoming fixtures, shaped for the shared player card. */
const fixturesFor = (p) => (d.fixtures || [])
  .filter((f) => f.event && (f.team_h === p.team || f.team_a === p.team))
  .map((f) => ({
    event: f.event,
    home: f.team_h === p.team,
    opponent: f.team_h === p.team ? f.team_a : f.team_h,
    difficulty: f.team_h === p.team ? f.team_h_difficulty : f.team_a_difficulty,
  }))
  .sort((a, b) => a.event - b.event);

function showPlayer(p) {
  playerCard(p, {
    teams,
    fixturesFor,
    horizon: 5,
    fromEvent: ctx?.nextEvent ?? 1,
    extra: el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Price'), el('span', { class: 'v' }, fmt.price(p.now_cost))),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, `Proj ${horizon} GW`), el('span', { class: 'v' }, fmt.pts(p.proj))),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Owned by'), el('span', { class: 'v' }, `${p.selected_by_percent}%`)),
    ),
  });
}

