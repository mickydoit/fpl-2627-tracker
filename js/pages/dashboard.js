/**
 * Classic → Squad. The master page.
 *
 * One continuous screen rather than a stack of dashboard cards, following the
 * composition in the Figma frame (236:2) and the density of the three WC Draft
 * frames (11:18 ladder, 21:684 fixtures, 82:138 stats):
 *
 *   metrics strip → pitch → window + rating → suggested squad
 *   → summary strip → this week's move → matches
 *
 * The rule those frames establish, and the one that matters most here: content
 * sits on the ground. A bordered container appears only where the design uses
 * one — the summary strip and the tables — never as a wrapper around every
 * idea. Section names are small labels, not headings inside boxes, and the
 * explanation that used to sit under each heading is now a `title` tooltip.
 *
 * Every number is produced by the existing engine. This file composes; it does
 * not compute. projectAll, rateSquad, optimiseWithinTransfers, suggestTransfers
 * and bestMove are called exactly as the pages they came from called them.
 */
import { loadAll, getState, setState, resolveSquadIds, readGameweek } from '../data.js';
import { projectAll, SQUAD_RULES, actionableEvent, livePointsFor } from '../model.js';
import { bestXI, scoreSquad, legalXI, optimiseWithinTransfers, squadCost, suggestTransfers } from '../optimiser.js';
import { rateSquad, RATING_HORIZONS } from '../rating.js';
import { topMoves, recommendedHorizon } from '../transfer-advice.js';
import { squadPitch, playerCard, enableSwapping, playerTile } from '../squadview.js';
import { notesFor, justifyMove, transferRows, noteRows } from '../explain.js';
import { matchesSection } from '../matches.js';
import { horizonCycler, cycler, SEASON_HORIZON } from '../ui.js';
import { $, el, fmt, dataBar, countdown, setKids, addKids, section, metric, compact } from '../ui.js';

const app = $('#app');
setKids(app); // clear the server-rendered loading state
const d = await loadAll();
$('#databar').replaceWith(dataBar(d.meta));
if (!d.boot) {
  setKids(app, el('p', { class: 'empty' }, 'No data yet — run the refresh workflow.'));
  throw new Error('no data');
}

const state = getState();
const teams = Object.fromEntries(d.boot.teams.map((t) => [t.id, t]));
const riskAversion = state.riskAversion ?? 0.5;
const bank = state.bank ?? 0;
const freeTransfers = state.freeTransfers ?? 1;
const fromEvent = actionableEvent(d.boot.events) ?? undefined;

/* One projection cache for the page. Every horizon the reader can select goes
   through here, so nothing is projected twice. */
const cache = new Map();
const rowsAt = (h) => {
  if (!cache.has(h)) cache.set(h, projectAll(d.boot, d.fixtures, { horizon: h, riskAversion, fromEvent }).rows);
  return cache.get(h);
};
const ctx = projectAll(d.boot, d.fixtures, { horizon: 5, riskAversion, fromEvent }).ctx;
const byId = (h) => new Map(rowsAt(h).map((r) => [r.id, r]));

const { ids: squadIds, source } = resolveSquadIds(d.entry, state);
const nextEvent = d.boot.events.find((e) => e.id === ctx.nextEvent);
const currentEvent = d.boot.events.find((e) => e.is_current);
const isLiveGW = !!currentEvent && !!d.live?.elements?.length;
const liveById = new Map((d.live?.elements || []).map((e) => [e.id, e]));

/* ------------------------------------------------------------------ *
 * small shared pieces
 * ------------------------------------------------------------------ */
const openPlayer = (p) => playerCard(p, {
  teams,
  fixturesFor: (q) => (d.fixtures || [])
    .filter((f) => f.event && (f.team_h === q.team || f.team_a === q.team))
    .map((f) => ({
      event: f.event,
      home: f.team_h === q.team,
      opponent: f.team_h === q.team ? f.team_a : f.team_h,
      difficulty: f.team_h === q.team ? f.team_h_difficulty : f.team_a_difficulty,
    }))
    .sort((a, b) => a.event - b.event),
  horizon: 5,
  fromEvent: ctx.nextEvent,
});

/* ------------------------------------------------------------------ *
 * gameweek strip
 * ------------------------------------------------------------------ */
/* The gameweek stepper sits alone above everything, as in the frame — it is a
   page-level control, not a section's. It walks back through gameweeks that
   have been archived so the review pitch below can show them. */
const playedGws = d.boot.events.filter((e) => e.id < ctx.nextEvent).map((e) => e.id).sort((a, b) => b - a);
let reviewGw = playedGws[0] ?? null;
const stepperHost = el('div', { class: 'sechead pagestep' });

const entry = d.entry?.entry;
const gwStrip = el('div', { class: 'metrics' });
/* Four metrics, matching Figma 244:1566 — deadline, points, value, transfers.
   Overall rank was mine and made five, which wrapped. */
const cdCell = metric('—', `GW${ctx.nextEvent}`, { hint: 'Time to the deadline' });
addKids(gwStrip, cdCell);
countdown(cdCell.querySelector('.mv'), nextEvent?.deadline_time);
if (entry) {
  addKids(gwStrip,
    metric(String(entry.summary_overall_points ?? '—'), 'Points'),
    metric(entry.last_deadline_value ? fmt.price(entry.last_deadline_value) : '—', 'Value',
      { hint: `${fmt.price(bank)} in the bank` }),
    metric(String(freeTransfers), 'Transfers'),
  );
}
/* The stepper goes up top; the four metrics do NOT. They are a summary of the
   squad — points, value, transfers — so they read as a caption underneath the
   board they summarise rather than as a banner the board hides behind. Sitting
   above, they cost ~200px between the gameweek control and the first shirt,
   which was most of the reason the bench fell off the bottom of the screen. */
addKids(app, stepperHost);

/* ------------------------------------------------------------------ *
 * the squad
 * ------------------------------------------------------------------ */
if (squadIds.length !== SQUAD_RULES.size) {
  const noSquad = section('Squad');
  addKids(noSquad.body,
    el('p', { class: 'empty' }, entry?.name
      ? 'FPL has not published your picks yet — they appear after the first deadline.'
      : 'Set FPL_ENTRY_ID, or build a squad on the Players page, and it will appear here.'));
  /* No squad to summarise, so the metrics have nothing to caption — they go
     back to the top, where they are the only thing on the page. */
  addKids(app, gwStrip, noSquad.wrap);
} else {
  const squad = squadIds.map((id) => byId(5).get(id)).filter(Boolean);
  const picks = d.entry?.picks?.picks || [];
  const pickMap = new Map(picks.map((p) => [p.element, p]));
  let captain = byId(5).get(picks.find((p) => p.is_captain)?.element);
  const vice = byId(5).get(picks.find((p) => p.is_vice_captain)?.element);

  /* The lineup window is the reader's. bestXI ranks on `proj`, so the window it
     is given decides the eleven — one gameweek answers "who starts Saturday",
     eight answers "who is worth keeping". */
  const LINEUP_HZ = 'lineupHorizon';
  let lineupH = getState()[LINEUP_HZ] ?? 1;
  const valueAt = (p) => byId(lineupH).get(p.id)?.proj ?? p.proj ?? 0;

  /* FPL's own order, not the model's. `position` 1-11 is the eleven you named
     and 12-15 is the bench IN THE ORDER IT WOULD BE USED — first sub on, second,
     third. Sorting the bench by projection showed a different squad from the one
     on your FPL account, which is the one thing this view must never do. */
  const byPosition = [...picks].sort((a, b) => a.position - b.position);
  let chosenXi = picks.length
    ? byPosition.filter((p) => p.position <= 11).map((p) => p.element)
    : bestXI(squad).xi.map((p) => p.id);
  const benchOrder = byPosition.filter((p) => p.position > 11).map((p) => p.element);
  const savedXi = getState().myXi;
  if (!isLiveGW && Array.isArray(savedXi) && savedXi.length === 11) {
    const rows = savedXi.map((id) => byId(5).get(id)).filter(Boolean);
    if (rows.length === 11 && legalXI(rows) && rows.every((r) => squad.some((s) => s.id === r.id))) chosenXi = savedXi;
  }

  const livePts = (p) => {
    const l = liveById.get(p.id);
    if (!l) return null;
    /* See livePointsFor: a bench multiplier of 0 must not zero the shirt. The
       XI total is unaffected — it sums `chosenXi` and never touches the bench. */
    return livePointsFor(l, pickMap.get(p.id));
  };

  const pitchHost = el('div');
  const paintPitch = () => {
    const xi = chosenXi.map((id) => byId(5).get(id)).filter(Boolean);
    const rest = squad.filter((p) => !chosenXi.includes(p.id));
    /* Bench in FPL's substitution order where we have it, and only falling back
       to whatever remains when we do not. */
    const benchRows = benchOrder.length
      ? benchOrder.map((id) => rest.find((p) => p.id === id)).filter(Boolean)
        .concat(rest.filter((p) => !benchOrder.includes(p.id)))
      : rest;
    const cap = xi.some((p) => p.id === captain?.id) ? captain : null;
    const pitch = squadPitch({
      xi, bench: benchRows, teams, captain: cap, vice, variant: 'classic',
      /* Live points only while the window IS the live gameweek. Stepping the
         cycler to 3, 5 or 8 is a request to look forward, and answering it
         with this week's actual scores made the control appear to do nothing
         for the whole of every gameweek — which is most of the time. */
      value: (p) => (isLiveGW && lineupH === 1
        ? String(livePts(p) ?? 0)
        : fmt.pts(valueAt(p) * (p.id === cap?.id ? 2 : 1))),
      onPlayer: openPlayer,
    });
    setKids(pitchHost, pitch);
    enableSwapping(pitch, {
      legal: (aId, bId) => {
        const inXi = (id) => chosenXi.includes(id);
        if (inXi(aId) === inXi(bId)) return false;
        const next = chosenXi.map((id) => (id === aId ? bId : id === bId ? aId : id));
        return legalXI(next.map((id) => byId(5).get(id)).filter(Boolean));
      },
      onSwap: (aId, bId) => {
        chosenXi = chosenXi.map((id) => (id === aId ? bId : id === bId ? aId : id));
        setState({ myXi: chosenXi });
        paintPitch();
      },
    });
  };
  paintPitch();

  const xiTotal = () => chosenXi.map((id) => byId(lineupH).get(id)).filter(Boolean)
    .reduce((t, p) => t + p.proj * (p.id === captain?.id ? 2 : 1), 0);
  const liveTotal = () => chosenXi.map((id) => byId(5).get(id)).filter(Boolean)
    .reduce((t, p) => t + (livePts(p) ?? 0), 0);

  /* No pill of its own — the Projections header immediately above it is the
     label, and a second heading between the two would just add noise. */
  const squadSec = section('', { flush: true });
  squadSec.head.remove();
  addKids(squadSec.body, pitchHost);

  /* The pills that separate the two boards, exactly as the frame has them:
     an outline label on the left, a filled control on the right. */
  const splitSec = section('Projections', {
    hint: 'What the squad is projected to do, against what it actually did',
  });
  splitSec.body.remove();
  const paintHead = () => setKids(splitSec.ctl,
    el('span', { class: 'inline-metric' },
      el('b', {}, isLiveGW && lineupH === 1 ? String(Math.round(liveTotal())) : fmt.pts(xiTotal())),
      el('i', {}, isLiveGW && lineupH === 1 ? 'pts' : `over ${lineupH === 1 ? 'GW' : `${lineupH} GW`}`)),
    horizonCycler(lineupH, (n) => {
      lineupH = n;
      setState({ [LINEUP_HZ]: n });
      paintPitch(); paintHead();
    }, { options: [1, 3, 5, 8] }));
  paintHead();

  /* Order of the page, and the reason for it.
   *
   * The first board is the RESULT: the exact eleven that was fielded, what each
   * player was projected to score and what he actually scored. That is the
   * question a manager opens the app with, and it used to sit below a board of
   * future projections. The projections board follows underneath, because
   * "what happens next" is the second question, not the first.
   *
   * Each control sits directly above the board it drives — the gameweek
   * stepper picks which gameweek is being reviewed, the Projections pill picks
   * the window the forecast covers. Putting both at the top would leave the
   * horizon cycler floating above a board it does not affect. */
  const reviewCol = el('div');
  const sideCol = el('div', { class: 'sidecol' });
  addKids(app, reviewCol, gwStrip, splitSec.wrap, squadSec.wrap, sideCol);

  /* ---------------- the review pitch ----------------
   *
   * The same eleven, showing what each player was PROJECTED to score in a
   * finished gameweek against what he actually scored. Two boxes, and only the
   * right one is coloured: the projection is the line, the result is what is
   * being judged against it.
   *
   * The gameweek stepper walks back through completed gameweeks. Anything it
   * shows was frozen at the time by scripts/archive-gameweek.mjs — the numbers
   * are not recomputed, because a projection recalculated today would be using
   * evidence that did not exist before that deadline.
   */
  if (playedGws.length) {
    const reviewHost = el('div');
    const paintReview = async () => {
      const g = await readGameweek(reviewGw);
      const step = (delta) => {
        const next = playedGws[playedGws.indexOf(reviewGw) + delta];
        if (next != null) { reviewGw = next; paintReview(); }
      };
      /* The stepper lives at the top of the page, not on this section — it is
         the page's gameweek, and the board below is what it shows. */
      setKids(stepperHost, el('div', { class: 'gwstep' },
        el('button', { class: 'prev', disabled: playedGws.indexOf(reviewGw) >= playedGws.length - 1,
          title: 'Earlier gameweek', onClick: () => step(1) }, 'Earlier'),
        el('span', { class: 'gwstep-label' }, `GW${reviewGw}`),
        el('button', { class: 'next', disabled: playedGws.indexOf(reviewGw) <= 0,
          title: 'Later gameweek', onClick: () => step(-1) }, 'Later')));

      const sec = section('', { flush: true });
      sec.head.remove();
      if (!g?.actual) {
        setKids(sec.body, el('p', { class: 'empty tight' }, `GW${reviewGw} has not been archived yet.`));
      } else {
        const xi = chosenXi.map((id) => byId(5).get(id)).filter(Boolean);
        const rest = squad.filter((p) => !chosenXi.includes(p.id));
        const bench = benchOrder.length
          ? benchOrder.map((id) => rest.find((p) => p.id === id)).filter(Boolean)
          : rest;
        /* By `code` — the archive is keyed that way because Draft and classic
           disagree on element ids for 21 of 587 players. */
        const compare = (p) => {
          const proj = g.projected?.[p.code];
          const act = g.actual?.[p.code]?.[0];
          if (act == null) return { left: proj == null ? '—' : proj.toFixed(1), right: '—' };
          const hit = proj == null ? 'met'
            : act >= proj - 0.1 ? (act > proj + 0.1 ? 'over' : 'met') : 'under';
          return { left: proj == null ? '—' : proj.toFixed(1), right: String(act), hit };
        };
        setKids(sec.body, squadPitch({
          xi, bench, teams, captain, vice, variant: 'classic',
          value: compare, onPlayer: openPlayer,
        }));
      }
      setKids(reviewHost, sec.wrap);
    };
    paintReview();
    addKids(reviewCol, reviewHost);
  }

  /* ---------------- notes ----------------
   *
   * Only what can be pointed at. FPL's own words are quoted and marked as
   * theirs; everything else is derived from the fixtures and projections
   * already on this page. Nothing is invented, and a player with nothing
   * remarkable about him produces no note at all — a panel that always has
   * something in it is one nobody reads.
   */
  {
    const rows = squad
      .map((p) => ({ p, notes: notesFor(p, { fixtures: d.fixtures, teams, fromEvent: ctx.nextEvent, horizon: 5 }) }))
      .filter((x) => x.notes.length)
      /* Loudest first: a flagged starter matters more than a set-piece note. */
      .sort((a, b) => {
        const rank = { bad: 0, warn: 1, good: 2, info: 3 };
        return rank[a.notes[0].tone] - rank[b.notes[0].tone] || b.p.proj - a.p.proj;
      });
    if (rows.length) {
      const sec = section('Notes', {
        hint: 'FPL’s own words where they exist, otherwise derived from fixtures and projections',
        flush: true,
      });
      addKids(sec.body, noteRows(rows, { teams, onPlayer: openPlayer, el }));
      addKids(app, sec.wrap);
    }
  }

  /* ---------------- rating + summary strip ---------------- */
  const RATING_HZ = 'ratingHorizon';
  let ratingH = RATING_HORIZONS.includes(getState()[RATING_HZ]) ? getState()[RATING_HZ] : 5;
  const ratingHost = el('div');
  const paintRating = () => {
    const rows = rowsAt(ratingH);
    const at = new Map(rows.map((r) => [r.id, r]));
    const mine = squadIds.map((id) => at.get(id)).filter(Boolean);
    if (mine.length !== SQUAD_RULES.size) return;
    const r = rateSquad(mine, { pool: rows, bank, freeTransfers });
    if (r.error) { setKids(ratingHost, el('p', { class: 'empty' }, r.error)); return; }
    const cap = r.parts.captain;
    const sec = section('Rating', {
      hint: 'How much of what your money could buy you are actually getting',
      control: horizonCycler(ratingH, (n) => { ratingH = n; setState({ [RATING_HZ]: n }); paintRating(); },
        { options: RATING_HORIZONS }),
      flush: true,
    });
    addKids(sec.body,
      /* The summary strip, straight from Figma 236:198 — a rule under the
         labels, one cell per fact. */
      el('div', { class: 'summary' },
        el('div', { class: 'sc' }, el('span', { class: 'sl' }, 'Rating'),
          el('span', { class: 'sv accent' }, String(r.overall))),
        el('div', { class: 'sc' }, el('span', { class: 'sl' }, 'Projection'),
          el('span', { class: 'sv' }, fmt.pts(r.parts.xiPts + r.parts.capPts))),
        el('div', { class: 'sc' }, el('span', { class: 'sl' }, 'Strength'),
          el('span', { class: 'sv' }, r.strongest.label)),
        el('div', { class: 'sc' }, el('span', { class: 'sl' }, 'Weakness'),
          el('span', { class: 'sv' }, r.weakest.label)),
        /* The model's pick, NOT the armband on the pitch — those are different
           claims and labelling both "Captain" made the page contradict itself.
           When they disagree, that disagreement is the useful bit. */
        el('div', { class: 'sc', title: 'The highest-projected starter — compare with the armband on the pitch' },
          el('span', { class: 'sl' }, 'Best cap'),
          el('span', { class: `sv ${cap && cap.id !== captain?.id ? 'accent' : ''}` }, cap ? cap.web_name : '—')),
      ));
    setKids(ratingHost, sec.wrap);
  };
  paintRating();
  addKids(sideCol, ratingHost);

  /* ---------------- suggested squad ---------------- */
  const OPT_HZ = 'optimiserTransfers';
  let plannedTransfers = getState()[OPT_HZ] ?? freeTransfers;
  /* The window the suggestion is judged over. It was fixed at eight, which is
     the right default for a squad you keep — but "best over the next gameweek"
     and "best over eight" are different questions and the reader should be able
     to ask either. Same option list as the lineup picker so the two agree. */
  const SUGGEST_HZ = 'suggestHorizon';
  let suggestH = [1, 3, 5, 8].includes(getState()[SUGGEST_HZ]) ? getState()[SUGGEST_HZ] : 8;
  const suggestHost = el('div');
  const paintSuggest = () => {
    const rows = rowsAt(suggestH);
    const reach = optimiseWithinTransfers(squadIds, rows, {
      bank, transfers: plannedTransfers, horizon: suggestH, riskAversion,
    });
    if (reach.error) { setKids(suggestHost, el('p', { class: 'empty' }, reach.error)); return; }
    const sec = section('Suggested squad', {
      hint: 'The best squad reachable with the transfers you have — no hits',
      control: [
        el('span', { class: 'inline-metric' },
          el('b', { class: reach.gain > 0 ? 'up' : '' }, reach.gain > 0 ? fmt.signed(reach.gain) : '—'),
          el('i', {}, `over ${suggestH === 1 ? 'GW' : `${suggestH} GW`}`)),
        horizonCycler(suggestH, (n) => { suggestH = n; setState({ [SUGGEST_HZ]: n }); paintSuggest(); },
          { options: [1, 3, 5, 8] }),
        cycler(plannedTransfers, [0, 1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} FT` })),
          (n) => { plannedTransfers = n; setState({ [OPT_HZ]: plannedTransfers }); paintSuggest(); },
          { title: 'Transfers to spend' }),
      ],
      flush: true,
    });
    addKids(sec.body,
      reach.moves.length
        ? transferRows(reach.moves, {
            teams, fixtures: d.fixtures, fromEvent: ctx.nextEvent, horizon: suggestH,
            /* Price and projection — the two numbers that decide a Classic
               transfer. The club used to sit here and the kit says it better. */
            statsFor: (p) => [
              { label: 'Price', value: fmt.price(p.now_cost), tone: 'muted' },
              { label: `Projection over ${suggestH} gameweek${suggestH === 1 ? '' : 's'}`, value: fmt.pts(p.proj) },
            ],
            onPlayer: openPlayer, playerTile, el,
          })
        : el('p', { class: 'empty tight' }, 'Nothing worth doing with those transfers.'));
    setKids(suggestHost, sec.wrap);
  };
  paintSuggest();
  addKids(sideCol, suggestHost);

  /* ---------------- this week's move ---------------- */
  const rec = recommendedHorizon({ squad, freeTransfers });
  const sug = suggestTransfers(squadIds, rowsAt(rec.horizon), {
    bank, freeTransfers, horizon: rec.horizon, riskAversion, maxSuggestions: 12,
  });
  if (!sug.error) {
    const gainAt = (move, h) => {
      const at = byId(h);
      const sq = squadIds.map((id) => at.get(id)).filter(Boolean);
      const inc = at.get(move.in.id);
      if (!inc) return 0;
      const base = scoreSquad(sq, { horizon: h, riskAversion });
      return scoreSquad(sq.filter((p) => p.id !== move.out.id).concat(inc), { horizon: h, riskAversion }) - base;
    };
    /* Five ALTERNATIVES for one transfer, not a five-transfer plan. Each is
       costed against the same bank and the same squad, so they do not stack. */
    const options = topMoves(sug.singles, gainAt, { hit: freeTransfers >= 1 ? 0 : 4, limit: 5 });
    const best = options[0] ?? null;
    const wk = section('This week', {
      hint: rec.why,
      control: el('span', { class: `verdict ${best?.move ? 'go' : 'hold'}` }, best?.verdict || 'HOLD'),
      flush: true,
    });
    addKids(wk.body,
      best?.move
        ? transferRows(options.map((o) => o.move), {
            teams, fixtures: d.fixtures, fromEvent: ctx.nextEvent, horizon: rec.horizon,
            statsFor: (p) => [
              { label: 'Price', value: fmt.price(p.now_cost), tone: 'muted' },
              { label: `Projection over ${rec.horizon} gameweeks`, value: fmt.pts(p.proj) },
            ],
            onPlayer: openPlayer, playerTile, el,
            verdictFor: (m, i) => options[i]?.verdict ?? null,
          })
        : el('p', { class: 'empty tight' }, 'No move clears the bar this week.'),
      best?.move && options.length > 1
        ? el('p', { class: 'seemore muted' },
            `${options.length} alternatives for one transfer — take one, not all of them. `
            + 'Only the rows marked STRONG or GOOD clear the bar.')
        : null,
      el('p', { class: 'seemore' }, el('a', { href: 'transfers.html' }, 'Every legal move →')));
    addKids(sideCol, wk.wrap);
  }
}

/* ------------------------------------------------------------------ *
 * matches
 * ------------------------------------------------------------------ */
/* Grouped by day, with a control for looking forward as well as back — see
   js/matches.js. The ESPN feed carries the whole window, so the filtering that
   used to happen here is now the view's job. */
const matchSec = matchesSection(d.scoreboard?.events || []);
if (matchSec) addKids(app, matchSec);
