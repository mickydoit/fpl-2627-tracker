/**
 * The Draft half of the Dashboard.
 *
 * Answers the four questions you have about your own Draft team on any given
 * morning: how is it scoring, how does it rank, who is at risk, and is anyone
 * on the waiver wire better than someone I own.
 *
 * Strictly Draft. It reads the Draft board dataset, the Draft league mirror and
 * Draft scoring; it never touches the Classic squad, Classic prices, Classic
 * transfers or the Classic optimiser. The two dashboards share a tab strip and
 * nothing else.
 */
import { el, setKids, fmt } from '../ui.js';
import { readSnapshot } from '../data.js';
import { projectBoard } from '../draft/project.js';
import { rateLeague, bestXI } from '../draft/rating.js';
import { DRAFT_CONFIG } from '../draft/config.js';
import { squadPitch, playerCard, activityRings, enableSwapping, legalDraftXI } from '../squadview.js';

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/** Minimum rest-of-season edge before a waiver swap is worth raising at all. */
const WAIVER_MIN_GAIN = DRAFT_CONFIG.minimumImprovement;

export async function renderDraftDashboard(host) {
  const [board, fixtures, league, live] = await Promise.all([
    readSnapshot('draft/players'),
    readSnapshot('fixtures', []),
    readSnapshot('draft/league', null),
    readSnapshot('draft/live', null),
  ]);

  if (!board?.players?.length) {
    setKids(host, el('p', { class: 'empty' }, 'The Draft board dataset has not been published yet.'));
    return;
  }
  if (!league?.ownership || !Object.keys(league.ownership).length) {
    setKids(host, el('div', { class: 'card' },
      el('h2', {}, 'No drafted squad yet'),
      el('p', {}, 'Once your Draft league has drafted, your squad, ranking and waiver suggestions appear here. '
        + 'Until then the Draft page runs the live draft assistant.')));
    return;
  }

  const teams = Object.fromEntries((board.teams || []).map((t) => [t.id, t]));
  const projected = projectBoard(board.players, fixtures, board.teams || []);
  const byId = new Map(projected.map((r) => [r.id, r]));

  const slotByEntry = new Map(league.managers.filter((m) => m.slot).map((m) => [m.entryId, m.slot]));
  const rostersBySlot = new Map();
  for (const [elementId, entryId] of Object.entries(league.ownership)) {
    const slot = slotByEntry.get(entryId);
    const row = byId.get(Number(elementId));
    if (!slot || !row) continue;
    if (!rostersBySlot.has(slot)) rostersBySlot.set(slot, []);
    rostersBySlot.get(slot).push(row);
  }
  /**
   * Which squad is mine.
   *
   * The mirror knows it only when FPL_DRAFT_ENTRY_ID is configured; failing
   * that, a draft entered on this device knows its own slot. If neither does,
   * say so — an unexplained empty dashboard is the worst of the three, and it
   * is what shipped the first time this ran without the variable set.
   */
  let mySlot = slotByEntry.get(league.myEntryId) ?? null;
  if (mySlot == null) {
    try {
      const local = JSON.parse(localStorage.getItem('draftState.v1') || 'null');
      if (local?.mySlot && rostersBySlot.has(local.mySlot)) mySlot = local.mySlot;
    } catch { /* unreadable storage is not worth failing over */ }
  }
  if (mySlot == null) {
    setKids(host, el('div', { class: 'card' },
      el('h2', {}, 'Which squad is yours?'),
      el('p', {}, `Your league's ${rostersBySlot.size} squads are mirrored, but nothing identifies which one is yours.`),
      el('p', { class: 'hint' }, 'Set the FPL_DRAFT_ENTRY_ID repository variable to your Draft entry id and the next refresh will label it. '
        + 'The League Hub on the Draft page still shows every squad meanwhile.')));
    return;
  }
  const mine = rostersBySlot.get(mySlot) || [];
  const ownedIds = new Set([...rostersBySlot.values()].flat().map((r) => r.id));
  const pool = projected.filter((r) => !ownedIds.has(r.id)).sort((a, b) => b.proj - a.proj);

  const rated = rateLeague(rostersBySlot, {
    pool, horizon: DRAFT_CONFIG.nearTermHorizon, seasonLength: DRAFT_CONFIG.rosHorizon,
  });
  const me = rated.find((r) => r.slot === mySlot);

  /* fixtures for the player card — the board rows carry team ids, and the
   * committed fixture list is keyed the same way as the Classic model. */
  const fixturesFor = (p) => (fixtures || [])
    .filter((f) => f.team_h === p.team || f.team_a === p.team)
    .map((f) => ({
      event: f.event,
      home: f.team_h === p.team,
      opponent: f.team_h === p.team ? f.team_a : f.team_h,
      difficulty: f.team_h === p.team ? f.team_h_difficulty : f.team_a_difficulty,
    }))
    .filter((f) => f.event)
    .sort((a, b) => a.event - b.event);

  const openPlayer = (p) => playerCard(p, { teams, fixturesFor, horizon: 5, fromEvent: nextEvent(fixtures) });

  const livePts = (p) => live?.elements?.[p.id]?.total_points ?? null;
  const gwLive = Boolean(live?.elements && Object.keys(live.elements).length);

  /**
   * Your chosen XI, which is not necessarily the best one.
   *
   * The board can compute the strongest legal eleven, but the eleven you
   * actually named on the FPL site is the one that scores — so the dashboard
   * has to be able to hold a lineup that differs from the optimum, and let you
   * push players around to see what a change costs.
   *
   * Stored under its own key: this is Draft state and must never reach the
   * Classic squad.
   */
  const XI_KEY = 'draftXi.v1';
  // Ranked on the next gameweek, which is the decision being made. The
  // rest-of-season number still drives squad RATING above — that is a
  // different question and rightly uses a different horizon.
  const byGw = (p) => p.gwValue ?? p.proj;
  const optimal = bestXI(mine, byGw);
  let chosen = optimal.xi.map((p) => p.id);
  try {
    const saved = JSON.parse(localStorage.getItem(XI_KEY) || 'null');
    if (Array.isArray(saved) && saved.length === 11) {
      const rows = saved.map((id) => mine.find((p) => p.id === id)).filter(Boolean);
      if (rows.length === 11 && legalDraftXI(rows)) chosen = saved;
    }
  } catch { /* unreadable storage is not worth failing over */ }

  const paintSquad = (into) => {
    const xi = chosen.map((id) => mine.find((p) => p.id === id)).filter(Boolean);
    const bench = mine.filter((p) => !chosen.includes(p.id));
    const chosenTotal = xi.reduce((t, p) => t + byGw(p), 0);
    const lost = optimal.total - chosenTotal;
    const gwTotal = xi.reduce((t, p) => t + (livePts(p) ?? 0), 0);

    const pitch = squadPitch({
      xi, bench, teams,
      value: (p) => (gwLive ? String(livePts(p) ?? 0) : fmt.pts(byGw(p))),
      sub: (p) => POS[p.element_type],
      onPlayer: openPlayer,
    });

    setKids(into,
      el('h2', {}, 'Squad'),
      el('p', { class: 'hint' },
        'Ranked by projected points for the next gameweek — the decision you are actually making. '
        + 'Drag a player onto another to swap them; hold to pick one up on a phone.'),
      el('div', { class: 'tiles' },
        el('div', { class: `tile ${gwLive ? 'accent' : ''}` },
          el('span', { class: 'k' }, gwLive ? 'Your XI, live' : 'Your XI, next GW'),
          el('span', { class: 'v' }, gwLive ? fmt.pts(gwTotal) : fmt.pts(chosenTotal)),
          el('span', { class: 's' }, 'the eleven you have named')),
        el('div', { class: 'tile' },
          el('span', { class: 'k' }, 'Strongest legal XI'),
          el('span', { class: 'v' }, fmt.pts(optimal.total)),
          el('span', { class: 's' }, 'best eleven for the next gameweek')),
        el('div', { class: `tile ${lost > 0.05 ? 'warn' : ''}` },
          el('span', { class: 'k' }, 'On your bench'),
          el('span', { class: 'v' }, lost > 0.05 ? `−${lost.toFixed(1)}` : '0.0'),
          el('span', { class: 's' }, lost > 0.05 ? 'points left out of the XI' : 'you are playing the optimum')),
      ),
      pitch,
      lost > 0.05
        ? el('button', { class: 'ghost', onClick: () => { chosen = optimal.xi.map((p) => p.id); save(); paintSquad(into); } },
          'Reset to the strongest XI')
        : null,
    );

    const save = () => { try { localStorage.setItem(XI_KEY, JSON.stringify(chosen)); } catch { /* ignore */ } };

    // A swap is legal when the resulting eleven still is. Keepers may only
    // trade with keepers, which legalDraftXI enforces by counting them.
    enableSwapping(pitch, {
      legal: (aId, bId) => {
        const inXi = (id) => chosen.includes(id);
        if (inXi(aId) === inXi(bId)) return false;
        const next = chosen.map((id) => (id === aId ? bId : id === bId ? aId : id));
        return legalDraftXI(next.map((id) => mine.find((p) => p.id === id)).filter(Boolean));
      },
      onSwap: (aId, bId) => {
        chosen = chosen.map((id) => (id === aId ? bId : id === bId ? aId : id));
        save();
        paintSquad(into);
      },
    });
  };

  const squadCard = el('div', { class: 'card' });
  paintSquad(squadCard);

  setKids(host,
    /* ---- headline: rings + gameweek ---- */
    el('div', { class: 'card' },
      el('h2', {}, 'My Draft team'),
      el('div', { class: 'dd-head' },
        me ? activityRings(
          [
            { label: 'Overall', value: me.rating, max: 100, colour: 'var(--lime, #9fed00)', detail: `${me.rank}${ord(me.rank)} of ${rated.length}` },
            { label: 'Best XI', value: me.percentiles.xi * 100, max: 100, colour: 'var(--cyan, #8bffec)', detail: `${me.xiRank}${ord(me.xiRank)}` },
            { label: 'Depth', value: me.percentiles.depth * 100, max: 100, colour: 'var(--yellow, #f4ff7b)', detail: `${me.depthRank}${ord(me.depthRank)}` },
          ],
          { value: String(me.rating), caption: 'rating' },
        ) : null,
        el('div', { class: 'tiles dd-tiles' },
          el('div', { class: 'tile accent' },
            el('span', { class: 'k' }, gwLive ? 'Gameweek points' : 'Gameweek'),
            el('span', { class: 'v' }, gwLive
              ? fmt.pts(chosen.map((id) => mine.find((p) => p.id === id)).filter(Boolean)
                .reduce((t, p) => t + (livePts(p) ?? 0), 0))
              : '—'),
            el('span', { class: 's' }, gwLive ? 'starting XI, live' : 'no matches played yet')),
          el('div', { class: 'tile' },
            el('span', { class: 'k' }, 'Rest of season'),
            el('span', { class: 'v' }, me ? fmt.pts(me.components.ros) : '—'),
            el('span', { class: 's' }, 'whole squad')),
          el('div', { class: 'tile' },
            el('span', { class: 'k' }, 'Flagged'),
            el('span', { class: 'v' }, String(mine.filter((p) => p.status && p.status !== 'a').length)),
            el('span', { class: 's' }, mine.filter((p) => p.status && p.status !== 'a').map((p) => p.web_name).join(', ') || 'all fit')),
        ),
      ),
    ),

    squadCard,

    riskCard(mine, openPlayer),
    waiverCard(mine, pool, teams, openPlayer),
  );
}

const ord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const nextEvent = (fixtures) => Math.min(...(fixtures || []).filter((f) => !f.finished && f.event).map((f) => f.event), 1);

/* ------------------------------------------------------------------ *
 * risk
 * ------------------------------------------------------------------ */
function riskCard(mine, openPlayer) {
  const flagged = mine
    .filter((p) => (p.status && p.status !== 'a') || (p.availability ?? 1) < 1)
    .sort((a, b) => b.proj * (1 - (b.availability ?? 1)) - a.proj * (1 - (a.availability ?? 1)));
  return el('div', { class: 'card' },
    el('h2', {}, 'Risks'),
    flagged.length
      ? el('ul', { class: 'hub-list' }, flagged.map((p) => el('li', { class: 'hub-player', onClick: () => openPlayer(p) },
        el('span', { class: 'hp-pos' }, POS[p.element_type]),
        el('span', { class: 'hp-name' }, p.web_name),
        el('span', { class: 'hp-val' }, `${Math.round((1 - (p.availability ?? 1)) * 100)}% risk`),
        el('span', { class: 'hp-news' }, p.news || 'flagged by FPL'))))
      : el('p', { class: 'hint' }, 'No availability flags in your squad.'),
  );
}

/* ------------------------------------------------------------------ *
 * waivers
 * ------------------------------------------------------------------ */
/**
 * Free agents who beat someone you own, at the same position.
 *
 * Deliberately conservative, and for the same reason the Classic transfer
 * adviser is being rebuilt: a marginal edge is not a reason to spend a waiver.
 * Only gaps of at least `minimumImprovement` rest-of-season points are shown,
 * and the wording never implies the move is obligatory.
 */
function waiverCard(mine, pool, teams, openPlayer) {
  const suggestions = [];
  for (const type of [1, 2, 3, 4]) {
    const owned = mine.filter((p) => p.element_type === type).sort((a, b) => a.proj - b.proj);
    const free = pool.filter((p) => p.element_type === type);
    if (!owned.length || !free.length) continue;
    const weakest = owned[0];
    const best = free[0];
    const gain = best.proj - weakest.proj;
    if (gain >= WAIVER_MIN_GAIN) suggestions.push({ out: weakest, in: best, gain });
  }
  suggestions.sort((a, b) => b.gain - a.gain);

  return el('div', { class: 'card' },
    el('h2', {}, 'Waiver watch'),
    el('p', { class: 'hint' },
      `Free agents projecting at least ${WAIVER_MIN_GAIN} points above your weakest player in that position, `
      + 'rest of season. Anything smaller is inside the model\'s own error and is not shown.'),
    suggestions.length
      ? el('div', { class: 'tablewrap' }, el('table', { class: 'players' },
        el('thead', {}, el('tr', {}, ...['Pos', 'Consider dropping', 'For', 'ROS gain'].map((h) => el('th', {}, h)))),
        el('tbody', {}, suggestions.map((s) => el('tr', {},
          el('td', {}, POS[s.out.element_type]),
          el('td', { onClick: () => openPlayer(s.out) }, `${s.out.web_name} (${teams[s.out.team]?.short_name || ''})`),
          el('td', { onClick: () => openPlayer(s.in) }, `${s.in.web_name} (${teams[s.in.team]?.short_name || ''})`),
          el('td', {}, el('strong', { class: 'up' }, `+${s.gain.toFixed(1)}`)))))))
      : el('p', { class: 'hint' }, 'Nothing on the wire is a clear enough upgrade to be worth a claim.'),
  );
}
