import { loadAll, getState, resolveSquadIds } from '../data.js';
import { projectAll, POS } from '../model.js';
import { bestXI, scoreSquad } from '../optimiser.js';
import { $, el, fmt, dataBar, countdown, statusBadge, posPill, modal, breakdown , setKids, addKids} from '../ui.js';

const app = $('#app');
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

  const shirt = (p, isCap) => {
    const lp = livePts(p);
    const shown = isLiveGW ? (lp ?? 0) : (p.projPerGW * (isCap ? 2 : 1));
    const l = liveById.get(p.id);
    return el('div', {
      class: `shirt ${isCap ? 'cap' : ''}`,
      title: `${p.first_name} ${p.second_name} — ${teams[p.team]?.name}`,
      onClick: () => showPlayer(p),
    },
      isCap ? el('span', { class: 'arm' }, 'C') : null,
      el('span', { class: 'nm' }, p.web_name),
      el('span', { class: 'pr' }, isLiveGW && l ? `${l.minutes}'` : fmt.price(p.now_cost)),
      el('span', { class: 'pt' }, fmt.pts(shown)),
    );
  };

  const rowFor = (pos) => {
    const ps = xi.filter((p) => p.element_type === pos);
    return ps.length ? el('div', { class: 'pitch-row' }, ps.map((p) => shirt(p, p === captain))) : null;
  };

  addKids(app, 
    el('div', { class: 'card' },
      head,
      el('div', { class: 'tiles' },
        el('div', { class: 'tile accent' },
          el('span', { class: 'k' }, isLiveGW ? 'Live points' : 'Projected points'),
          el('span', { class: 'v' }, fmt.pts(total)),
          el('span', { class: 's' }, isLiveGW ? 'includes provisional bonus once official' : `captain: ${captain?.web_name || '—'}`),
        ),
        el('div', { class: 'tile' },
          el('span', { class: 'k' }, `Next ${horizon} GWs`),
          el('span', { class: 'v' }, fmt.pts(scoreSquad(squad, { horizon }))),
          el('span', { class: 's' }, 'XI + captain + weighted bench'),
        ),
        el('div', { class: 'tile' },
          el('span', { class: 'k' }, 'Flagged players'),
          el('span', { class: 'v' }, squad.filter((p) => p.status !== 'a').length),
          el('span', { class: 's' }, squad.filter((p) => p.status !== 'a').map((p) => p.web_name).join(', ') || 'all fit'),
        ),
      ),
      el('div', { class: 'pitch' },
        [1, 2, 3, 4].map(rowFor).filter(Boolean),
        el('div', { class: 'bench-strip' }, bench.map((p) => shirt(p, false))),
      ),
    ),
  );
} else {
  addKids(app, 
    el('div', { class: 'card' },
      el('h2', {}, 'No squad yet'),
      el('p', {},
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
function showPlayer(p) {
  const t = teams[p.team];
  const body = el('div', {},
    el('p', { class: 'row' }, posPill(p), el('strong', {}, `${p.first_name} ${p.second_name}`), el('span', { class: 'dim' }, t?.name), statusBadge(p)),
    p.news ? el('p', { class: 'small badge warn', style: 'display:block;padding:0.4rem 0.6rem' }, p.news) : null,
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Price'), el('span', { class: 'v' }, fmt.price(p.now_cost))),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, `Proj ${horizon} GW`), el('span', { class: 'v' }, fmt.pts(p.proj))),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Owned by'), el('span', { class: 'v' }, `${p.selected_by_percent}%`)),
    ),
    el('h3', {}, 'Per-gameweek breakdown'),
    breakdown(p.parts || {}),
    p.parts?.isPrior
      ? el('p', { class: 'hint' }, 'Limited minutes on record — this projection leans on a price-based prior rather than his own data.')
      : null,
  );
  modal(p.web_name, body);
}
