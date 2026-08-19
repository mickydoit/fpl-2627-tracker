/**
 * The League Hub — what the Draft page becomes once the draft is finished.
 *
 * It is the same page and the same state. The pick log stays the historical
 * record; rosters, the free-agent pool and every rating are derived from it,
 * exactly as they were on draft night. Nothing here fetches anything: if the
 * optional league mirror is missing, managers are "Slot 3" instead of a name
 * and everything else is identical.
 */
import { el, setKids } from '../ui.js';
import { rateLeague } from '../draft/rating.js';
import { DRAFT_CONFIG } from '../draft/config.js';

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const one = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '—');

/**
 * Manager identity, best available.
 *
 * The league mirror knows real names but keys them by entry id, and only knows
 * a slot once the draft has run. Anything unmatched falls back to the slot
 * number rather than guessing — a wrong name on a squad is worse than no name.
 */
function nameFor(slot, league, mySlot) {
  const m = league?.managers?.find((x) => x.slot === slot);
  const mine = slot === mySlot;
  if (m) return { label: m.teamName || m.manager || `Slot ${slot}`, sub: m.manager || '', mine };
  return { label: mine ? 'Your squad' : `Slot ${slot}`, sub: '', mine };
}

function playerLine(p, extra) {
  return el('li', { class: 'hub-player' },
    el('span', { class: 'hp-pos' }, POS[p.element_type]),
    el('span', { class: 'hp-name' }, p.web_name),
    p.availability < 1 ? el('span', { class: 'hp-flag', title: p.news || '' }, '!') : null,
    el('span', { class: 'hp-val' }, one(p.proj)),
    extra || null,
  );
}

/* ------------------------------------------------------------------ *
 * my team
 * ------------------------------------------------------------------ */
function myTeamCard(me, league, mySlot, total) {
  if (!me) return null;
  const c = me.components;
  const who = nameFor(mySlot, league, mySlot);

  // The weakest position by league rank, which is what "where do I improve"
  // actually means. Ties break toward the position with fewer starters.
  const weakest = [1, 2, 3, 4]
    .map((t) => ({ t, rank: me.posRank[t] }))
    .sort((a, b) => b.rank - a.rank || a.t - b.t)[0];
  const strongest = [1, 2, 3, 4]
    .map((t) => ({ t, rank: me.posRank[t] }))
    .sort((a, b) => a.rank - b.rank || a.t - b.t)[0];

  return el('div', { class: 'card hub-me' },
    el('h2', {}, 'My team'),
    el('div', { class: 'hub-headline' },
      el('div', { class: 'hh-rating' },
        el('span', { class: 'hh-num' }, String(me.rating)),
        el('span', { class: 'hh-den' }, '/100')),
      el('div', { class: 'hh-rank' },
        el('strong', {}, `${me.rank}${ordinal(me.rank)} of ${total}`),
        el('span', {}, who.sub ? `${who.label} · ${who.sub}` : who.label)),
    ),
    el('div', { class: 'hub-grid' },
      metric('Best XI', `${one(c.xi.total)} pts`, `${me.xiRank}${ordinal(me.xiRank)}`),
      metric('Rest of season', `${one(c.ros)} pts`, ''),
      metric('Depth', `−${one(c.depth.perAbsence, 1)} per absence`, `${me.depthRank}${ordinal(me.depthRank)}`),
      metric('VORP over free agents', one(c.vorp.total), ''),
      metric('Injury risk', `${one(c.risk.score * 100)}%`, ''),
      metric('Next 5 outlook', `${c.fixtures.toFixed(2)}×`, ''),
    ),
    el('div', { class: 'hub-poscols' }, ...[1, 2, 3, 4].map((t) => el('div', { class: 'pc' },
      el('span', { class: 'pc-k' }, POS[t]),
      el('span', { class: 'pc-v' }, `${me.posRank[t]}${ordinal(me.posRank[t])}`),
      el('span', { class: 'pc-s' }, `${one(c.byPos[t].startersRos)} pts`)))),
    // Written from the numbers above and nothing else. Every clause is a
    // rendering of a computed value, so it cannot drift from the model.
    el('p', { class: 'hub-summary' },
      `Strongest at ${POS[strongest.t]} (${strongest.rank}${ordinal(strongest.rank)} in the league), `
      + `weakest at ${POS[weakest.t]} (${weakest.rank}${ordinal(weakest.rank)}). `
      + (c.depth.worst
        ? `Losing ${c.depth.worst.player.web_name} would cost the most — ${one(c.depth.worst.drop, 1)} points off your best XI. `
        : '')
      + (c.risk.flagged.length
        ? `${c.risk.flagged.length} player${c.risk.flagged.length === 1 ? '' : 's'} carrying an availability flag.`
        : 'No availability flags.')),
  );
}

function metric(label, value, rank) {
  return el('div', { class: 'hub-metric' },
    el('span', { class: 'hm-k' }, label),
    el('span', { class: 'hm-v' }, value),
    rank ? el('span', { class: 'hm-r' }, rank) : null);
}

const ordinal = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'st'
  : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

/* ------------------------------------------------------------------ *
 * power rankings
 * ------------------------------------------------------------------ */
function powerTable(rated, league, mySlot, onOpen) {
  return el('div', { class: 'card' },
    el('h2', {}, 'League power rankings'),
    el('p', { class: 'hint' },
      'Rating blends best XI, rest-of-season strength, depth, value over free agents and injury risk — '
      + 'each as a percentile within this league. Every column behind it is shown, so a rank is always explainable.'),
    el('div', { class: 'tablewrap' }, el('table', { class: 'players' },
      el('thead', {}, el('tr', {},
        ...['#', 'Manager', 'Rating', 'ROS', 'XI', 'Depth', 'VORP', 'Risk', 'GK', 'DEF', 'MID', 'FWD']
          .map((h) => el('th', {}, h)))),
      el('tbody', {}, rated.map((r) => {
        const who = nameFor(r.slot, league, mySlot);
        const c = r.components;
        return el('tr', {
          class: who.mine ? 'mine hub-row' : 'hub-row',
          onClick: () => onOpen(r.slot),
        },
        el('td', {}, String(r.rank)),
        el('td', {}, who.label + (who.mine ? ' (you)' : '')),
        el('td', {}, el('strong', {}, String(r.rating))),
        el('td', {}, one(c.ros)),
        el('td', {}, one(c.xi.total)),
        el('td', {}, `−${one(c.depth.perAbsence, 1)}`),
        el('td', {}, one(c.vorp.total)),
        el('td', {}, `${one(c.risk.score * 100)}%`),
        ...[1, 2, 3, 4].map((t) => el('td', {}, String(r.posRank[t]))));
      })))),
  );
}

/* ------------------------------------------------------------------ *
 * one manager
 * ------------------------------------------------------------------ */
function managerCard(r, league, mySlot, onClose) {
  const c = r.components;
  const who = nameFor(r.slot, league, mySlot);
  return el('div', { class: 'card hub-manager' },
    el('div', { class: 'hub-mhead' },
      el('h2', {}, who.label),
      el('button', { class: 'ghost', onClick: onClose }, 'Close')),
    who.sub ? el('p', { class: 'hint' }, who.sub) : null,
    el('div', { class: 'hub-grid' },
      metric('Rating', String(r.rating), `${r.rank}${ordinal(r.rank)}`),
      metric('Best XI', one(c.xi.total), `${r.xiRank}${ordinal(r.xiRank)}`),
      metric('Rest of season', one(c.ros), ''),
      metric('Depth', `−${one(c.depth.perAbsence, 1)}`, `${r.depthRank}${ordinal(r.depthRank)}`),
    ),
    el('div', { class: 'hub-two' },
      el('div', {},
        el('h3', {}, `Best XI — ${one(c.xi.total)} pts`),
        el('ul', { class: 'hub-list' }, c.xi.players.map((p) => playerLine(p)))),
      el('div', {},
        el('h3', {}, `Bench — ${c.xi.bench.length}`),
        el('ul', { class: 'hub-list' }, c.xi.bench.map((p) => playerLine(p)))),
    ),
    c.risk.flagged.length
      ? el('div', {}, el('h3', {}, 'Availability'),
        el('ul', { class: 'hub-list' }, c.risk.flagged.map((p) => playerLine(p,
          el('span', { class: 'hp-news' }, p.news || 'flagged')))))
      : null,
  );
}

/* ------------------------------------------------------------------ *
 * free agents
 * ------------------------------------------------------------------ */
function freeAgents(pool, state) {
  let pos = 0;
  const body = el('tbody', {});
  const fill = () => setKids(body, ...pool
    .filter((p) => !pos || p.element_type === pos)
    .slice(0, 40)
    .map((p) => el('tr', {},
      el('td', {}, p.web_name),
      el('td', {}, POS[p.element_type]),
      el('td', {}, one(p.proj)),
      el('td', {}, one(p.nearTermValue)),
      el('td', {}, p.availability < 1 ? (p.news || 'doubt') : ''))));
  fill();

  return el('div', { class: 'card' },
    el('h2', {}, 'Free agents'),
    el('p', { class: 'hint' },
      `${pool.length} players went undrafted. Ranked by rest-of-season projection — `
      + 'the waiver engine that compares these against your own squad comes next.'),
    el('div', { class: 'chiprow' }, ...[0, 1, 2, 3, 4].map((t) => el('button', {
      class: `chip ${t === pos ? 'on' : ''}`,
      onClick: (e) => {
        pos = t;
        [...e.currentTarget.parentElement.children].forEach((c, i) => c.classList.toggle('on', i === t));
        fill();
      },
    }, t ? POS[t] : 'All'))),
    el('div', { class: 'tablewrap' }, el('table', { class: 'players' },
      el('thead', {}, el('tr', {}, ...['Player', 'Pos', 'ROS', 'Next 5', ''].map((h) => el('th', {}, h)))),
      body)),
  );
}

/* ------------------------------------------------------------------ *
 * entry point
 * ------------------------------------------------------------------ */
/**
 * @param {object} o
 * @param {Map<number,object[]>} o.rostersBySlot projected rows per draft slot
 * @param {object[]} o.pool undrafted projected rows
 * @param {object|null} o.league data/draft/league.json, or null
 * @param {number} o.mySlot
 * @param {() => void} o.onShowDraft return to the pick log
 */
export function renderHub({ rostersBySlot, pool, league, mySlot, onShowDraft }) {
  const rated = rateLeague(rostersBySlot, {
    pool,
    horizon: DRAFT_CONFIG.nearTermHorizon,
    seasonLength: DRAFT_CONFIG.rosHorizon,
  });
  const me = rated.find((r) => r.slot === mySlot) || null;
  const host = el('div', {});
  let open = null;

  const paint = () => {
    const openRated = open == null ? null : rated.find((r) => r.slot === open);
    setKids(host,
      myTeamCard(me, league, mySlot, rated.length),
      openRated ? managerCard(openRated, league, mySlot, () => { open = null; paint(); }) : null,
      powerTable(rated, league, mySlot, (slot) => { open = slot === open ? null : slot; paint(); }),
      freeAgents(pool),
      el('div', { class: 'card' },
        el('h2', {}, 'Draft'),
        el('p', { class: 'hint' }, 'The pick log is kept in full — every pick, in order, exactly as it was entered.'),
        el('button', { class: 'ghost', onClick: onShowDraft }, 'Show the draft log')),
    );
  };
  paint();
  return host;
}
