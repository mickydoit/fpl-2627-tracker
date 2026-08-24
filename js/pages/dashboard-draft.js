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
import { el, setKids, fmt, horizonPicker, section } from '../ui.js';
import { readSnapshot } from '../data.js';
import { projectBoard, projectBoardAt } from '../draft/project.js';
import { actionableEvent } from '../model.js';
import { rateLeague, bestXI } from '../draft/rating.js';
import { DRAFT_CONFIG, RATING_HORIZONS } from '../draft/config.js';
import { bestWaiver } from '../draft/waiver.js';
import { squadPitch, playerCard, activityRings, enableSwapping, legalDraftXI } from '../squadview.js';

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/** section(), in the shape the card builders below already return: one call,
 *  children as trailing arguments. */
const sectionOf = (name, opts, ...kids) => {
  const sec = section(name, opts);
  setKids(sec.body, ...kids.filter(Boolean));
  return sec.wrap;
};

/** Minimum rest-of-season edge before a waiver swap is worth raising at all. */
const WAIVER_MIN_GAIN = DRAFT_CONFIG.minimumImprovement;

/**
 * Which sections of the Draft view to render.
 *
 * The Draft product now has its own pages rather than one scrolling dashboard,
 * and they are all built from the same data prep — the rosters, the pool and
 * the projections cost the same to compute whichever card ends up on screen.
 * So the composition is a parameter and NOTHING below it changed: every card
 * is the one that was already working, rendered into a different page.
 */
export const DRAFT_SECTIONS = ['head', 'squad', 'risk', 'waiver'];

export async function renderDraftDashboard(host, { sections = DRAFT_SECTIONS } = {}) {
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

  /* A waiver claim made now cannot score from a gameweek whose deadline has
     already gone, so the adviser measures from the first one it can affect.
     Deliberately not applied to the live draft board, which is a different
     decision: scarcity there is about who survives to the next pick, not about
     transaction deadlines. */
  const actionable = actionableEvent(board.events) ?? undefined;
  const horizonCache = new Map();
  const rowsAt = (h) => {
    if (!horizonCache.has(h)) {
      const projAt = projectBoardAt(board.players, fixtures, board.teams, h, { fromEvent: actionable });
      const byIdNow = new Map(projected.map((r) => [r.id, r]));
      horizonCache.set(h, new Map([...projAt].map(([id, proj]) => [id, { ...byIdNow.get(id), proj }])));
    }
    return horizonCache.get(h);
  };

  /**
   * The rating horizon is the reader's to choose, and it is a different
   * question from the lineup horizon further down the page.
   *
   * "Who do I start on Saturday" and "how good is this squad" want different
   * windows — reading the season rating while naming a lineup for the next
   * gameweek is a perfectly ordinary thing to want — so the two pickers keep
   * separate state and neither drags the other.
   *
   * Deliberately NOT built on rowsAt(). That measures from the first gameweek
   * a waiver claim could still affect, which is right for the adviser and
   * wrong here: a rating describes the squad you have, including the gameweek
   * already under way. Passing fromEvent moves the season total by 25 points
   * without saying so — scripts/test-draft.mjs holds the two apart.
   */
  const RATING_HZ_KEY = 'draftRatingHorizon';
  const SEASON = RATING_HORIZONS[RATING_HORIZONS.length - 1];
  let ratingH = SEASON;
  try {
    const saved = Number(localStorage.getItem(RATING_HZ_KEY));
    if (RATING_HORIZONS.includes(saved)) ratingH = saved;
  } catch { /* unreadable storage is not worth failing over */ }

  /* Seeded with the board's own rest-of-season rows, which is what the whole
     season window means — no re-projection, and no drift against the number
     the page showed before this control existed. */
  const ratingCache = new Map([[SEASON, new Map(projected.map((r) => [r.id, r]))]]);
  const ratingRowsAt = (h) => {
    if (!ratingCache.has(h)) {
      const projAt = projectBoardAt(board.players, fixtures, board.teams || [], h);
      ratingCache.set(h, new Map([...projAt].map(([id, proj]) => [id, { ...byId.get(id), proj }])));
    }
    return ratingCache.get(h);
  };

  /* Every squad in the league is re-rated at the chosen window, not just mine:
     the headline is a comparison, so moving the window has to move everyone or
     it means nothing. Six rosters and a depth pass cost single-digit
     milliseconds, and each window is cached after its first visit. */
  const rateAt = (h) => {
    const rows = ratingRowsAt(h);
    const rosters = new Map([...rostersBySlot].map(([slot, rs]) =>
      [slot, rs.map((p) => rows.get(p.id)).filter(Boolean)]));
    return rateLeague(rosters, {
      pool: [...rows.values()].filter((r) => !ownedIds.has(r.id)),
      horizon: DRAFT_CONFIG.nearTermHorizon,
      seasonLength: DRAFT_CONFIG.rosHorizon,
    });
  };

  let rated = rateAt(ratingH);
  let me = rated.find((r) => r.slot === mySlot);

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
  /**
   * The lineup horizon is the reader's to choose.
   *
   * One gameweek answers "who do I start on Saturday"; ten answers "who is
   * worth keeping through a fixture swing". Both are legitimate and they give
   * different elevens, so the window is a control rather than an assumption.
   * Squad RATING stays on rest-of-season regardless — that is a different
   * question and must not move when this does.
   */
  const HZ_KEY = 'draftLineupHorizon';
  let lineupH = 1;
  try { lineupH = Number(localStorage.getItem(HZ_KEY)) || 1; } catch { /* ignore */ }
  const hzCache = new Map([[1, new Map(projected.map((r) => [r.id, r.gwValue ?? r.proj]))]]);
  const valuesAt = (h) => {
    if (!hzCache.has(h)) hzCache.set(h, projectBoardAt(board.players, fixtures, board.teams || [], h));
    return hzCache.get(h);
  };
  let byGw = (p) => valuesAt(lineupH).get(p.id) ?? p.proj;
  let optimal = bestXI(mine, byGw);
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
          variant: 'draft',
    });

    setKids(into,
      el('div', { class: 'row between' }, el('h2', {}, 'Squad'),
        horizonPicker(lineupH, (n) => {
          lineupH = n;
          try { localStorage.setItem(HZ_KEY, String(n)); } catch { /* ignore */ }
          byGw = (p) => valuesAt(lineupH).get(p.id) ?? p.proj;
          optimal = bestXI(mine, byGw);
          paintSquad(into);
        })),
      el('p', { class: 'hint' },
        `Ranked by projected points over ${lineupH === 1 ? 'the next gameweek' : `the next ${lineupH} gameweeks`}`
        + ' — change the window top right. Drag a player onto another to swap them; hold to lift on a phone.'),
      el('div', { class: 'tiles' },
        el('div', { class: `tile ${gwLive ? 'accent' : ''}` },
          el('span', { class: 'k' }, gwLive ? 'Your XI, live' : `Your XI, ${lineupH === 1 ? 'next GW' : `next ${lineupH}`}`),
          el('span', { class: 'v' }, gwLive ? fmt.pts(gwTotal) : fmt.pts(chosenTotal)),
          el('span', { class: 's' }, 'the eleven you have named')),
        el('div', { class: 'tile' },
          el('span', { class: 'k' }, 'Strongest legal XI'),
          el('span', { class: 'v' }, fmt.pts(optimal.total)),
          el('span', { class: 's' }, lineupH === 1 ? 'best eleven for the next gameweek' : `best eleven over ${lineupH} gameweeks`)),
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

  const squadSec = section('Squad', { flush: true });
  const squadCard = squadSec.wrap;
  paintSquad(squadSec.body);

  /* ---- headline: rings + gameweek ---- */
  const headSec = section('My Draft team', { hint: 'Rated against every rival in your league' });
  const headCard = headSec.wrap;

  /* The rings and the squad total are the only things the rating window moves.
     Live gameweek points are what was actually scored, and the flagged count is
     a fact about today — neither has a horizon to follow. */
  const paintHead = () => {
    rated = rateAt(ratingH);
    me = rated.find((r) => r.slot === mySlot);
    const windowLabel = ratingH >= SEASON ? 'Rest of season'
      : ratingH === 1 ? 'Next gameweek' : `Next ${ratingH} gameweeks`;
    setKids(headSec.ctl,
      horizonPicker(ratingH, (n) => {
        ratingH = n;
        try { localStorage.setItem(RATING_HZ_KEY, String(n)); } catch { /* ignore */ }
        paintHead();
      }, { options: RATING_HORIZONS }));
    headSec.head.querySelector('.seclabel').title =
      `Rated against your ${rated.length - 1} rivals over ${windowLabel.toLowerCase()}`;
    setKids(headSec.body,
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
            el('span', { class: 'k' }, windowLabel),
            el('span', { class: 'v' }, me ? fmt.pts(me.components.ros) : '—'),
            el('span', { class: 's' }, 'whole squad')),
          el('div', { class: 'tile' },
            el('span', { class: 'k' }, 'Flagged'),
            el('span', { class: 'v' }, String(mine.filter((p) => p.status && p.status !== 'a').length)),
            el('span', { class: 's' }, mine.filter((p) => p.status && p.status !== 'a').map((p) => p.web_name).join(', ') || 'all fit')),
        ),
      ),
    );
  };
  paintHead();

  const want = new Set(sections);
  setKids(host, ...[
    want.has('head') ? headCard : null,
    want.has('squad') ? squadCard : null,
    want.has('risk') ? riskCard(mine, openPlayer) : null,
    want.has('waiver') ? waiverCard(mine, pool, teams, openPlayer, rowsAt) : null,
  ].filter(Boolean));

  /* The League page needs the same rosters and pool this function just built.
     Returned rather than recomputed so the two pages cannot drift apart. */
  return { rostersBySlot, pool, league, mySlot, teams, byId, projected, openPlayer };
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
  return sectionOf('Risks', { flush: true },
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
function waiverCard(mine, pool, teams, openPlayer, rowsAt) {
  /* Was a player-to-player comparison: the best free agent at a position
     against your weakest player there. That answers the wrong question. It
     ignored what the move does to the rest of the roster, agreed with itself at
     only one horizon, and could not tell a proven player from a projection made
     mostly of prior. It now runs the season adviser, which evaluates the whole
     roster over four horizons and is allowed to say no. */
  const advice = rowsAt ? bestWaiver(mine, pool, rowsAt) : null;
  const isMove = advice && (advice.verdict === 'STRONG ADD' || advice.verdict === 'GOOD ADD');
  /* The explanation moved to the label's tooltip: a Draft drop is permanent —
     unique ownership means there is no buying him back — so a move has to beat
     the player you own by a real margin. True, and not worth three lines of the
     page every time you look at it. */
  return sectionOf('Waiver watch', {
    flush: true,
    hint: 'Every legal add-drop over 1, 3, 5 and 8 gameweeks. A Draft drop is permanent, so a move must clear a real margin.',
  },
    advice
      ? el('div', { class: `advice ${isMove ? 'good' : 'hold'}` },
        el('p', { class: 'advice-verdict' }, advice.verdict),
        el('p', { class: 'advice-move' },
          el('span', { onClick: () => openPlayer(advice.move.out) }, `${advice.move.out.web_name} (${teams[advice.move.out.team]?.short_name || ''})`),
          ' → ',
          el('span', { onClick: () => openPlayer(advice.move.in) }, `${advice.move.in.web_name} (${teams[advice.move.in.team]?.short_name || ''})`)),
        el('div', { class: 'tiles' }, advice.cross.gains.map((g) => el('div', { class: 'tile' },
          el('span', { class: 'k' }, `Next ${g.horizon}`),
          el('span', { class: 'v' }, `${g.gain >= 0 ? '+' : ''}${g.gain.toFixed(1)}`)))),
        el('p', { class: 'hint' }, `Confidence ${advice.confidence}. ${advice.reasons.join('; ')}.`))
      : el('p', { class: 'hint' }, 'Nothing on the wire improves this roster.'),
  );
}
