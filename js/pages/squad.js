import { loadAll, getState, setState, resolveSquadIds } from '../data.js';
import { projectAll, POS, SQUAD_RULES, actionableEvent } from '../model.js';
import { rateSquad } from '../rating.js';
import { optimiseSquad, validate, squadCost, bestXI, canSwap, splitXI, scoreSquad,
  optimiseWithinTransfers } from '../optimiser.js';
import { squadPitch, playerCard } from '../squadview.js';
import { fdrLegend, horizonBadge } from '../ui.js';
import { suggestTransfers } from '../optimiser.js';
import { bestMove, recommendedHorizon } from '../transfer-advice.js';
import { $, el, fmt, dataBar, posPill, statusBadge, penBadge, fdrTicker, modal, breakdown , setKids, addKids} from '../ui.js';

const app = $('#app');
const d = await loadAll();
$('#databar').replaceWith(dataBar(d.meta));
if (!d.boot) { setKids(app, el('p', { class: 'empty' }, 'No data yet — run the refresh workflow.')); throw new Error('no data'); }

const state = getState();
let horizon = state.horizon ?? 5;
let budget = state.budget ?? SQUAD_RULES.budget;
let riskAversion = state.riskAversion ?? 0.5;
let benchWeight = state.benchWeight ?? 0.12;
let locked = new Set(state.locked || []);
let excluded = new Set(state.excluded || []);
let manualXi = state.manualXi || null;
/**
 * How many transfers the reachable squad may spend.
 *
 * Seeded from the free-transfer count set on the Transfers page, but stored
 * under its own key: asking "what would banking three buy me?" is a question
 * about a hypothetical, and answering it must not overwrite what you actually
 * have. FPL banks to five, so that is the ceiling.
 */
let plannedTransfers = state.optimiserTransfers ?? state.freeTransfers ?? 1;
let result = null;
let lastMs = 0;

let rows = [];
let ctx = null;
let byId = new Map();
const teams = Object.fromEntries(d.boot.teams.map((t) => [t.id, t]));

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


function recompute() {
  const r = projectAll(d.boot, d.fixtures, { horizon, riskAversion });
  rows = r.rows;
  ctx = r.ctx;
  byId = new Map(rows.map((p) => [p.id, p]));
}

/* ------------------------------------------------------------------ *
 * controls
 * ------------------------------------------------------------------ */
const controls = el('div', { class: 'card' });
const output = el('div', {});
setKids(app, controls, output);

function numberField(label, value, attrs, onChange) {
  const input = el('input', { type: 'number', value, ...attrs, oninput: (e) => onChange(e.target.value) });
  return el('label', {}, label, input);
}

function renderControls() {
  setKids(controls, 
    el('div', { class: 'filters' },
      el('label', {}, 'Horizon',
        el('select', { onchange: (e) => { horizon = +e.target.value; setState({ horizon }); run(); } },
          [1, 3, 5, 8, 10].map((n) => el('option', { value: n, selected: n === horizon }, `${n} GW`)))),
      numberField('Budget (£m)', (budget / 10).toFixed(1), { step: '0.1', min: '80', max: '110', style: 'width:6rem' },
        (v) => { budget = Math.round(parseFloat(v) * 10) || SQUAD_RULES.budget; setState({ budget }); }),
      el('label', {}, 'Risk aversion',
        el('select', { onchange: (e) => { riskAversion = +e.target.value; setState({ riskAversion }); run(); } },
          [['0', 'Ignore doubts'], ['0.5', 'Balanced'], ['1', 'Avoid all doubts']].map(([v, l]) =>
            el('option', { value: v, selected: +v === riskAversion }, l)))),
      el('label', {}, 'Bench value',
        el('select', { onchange: (e) => { benchWeight = +e.target.value; setState({ benchWeight }); run(); } },
          [['0.02', 'Minimal — max the XI'], ['0.12', 'Balanced'], ['0.35', 'Strong bench']].map(([v, l]) =>
            el('option', { value: v, selected: +v === benchWeight }, l)))),
      el('label', {}, 'Transfers available',
        el('select', { onchange: (e) => { plannedTransfers = +e.target.value; setState({ optimiserTransfers: plannedTransfers }); run(); } },
          [0, 1, 2, 3, 4, 5].map((n) => el('option', { value: n, selected: n === plannedTransfers }, String(n))))),
      el('button', { class: 'primary', onClick: run }, 'Optimise squad'),
    ),
    el('p', { class: 'hint' },
      `£${(budget / 10).toFixed(1)}m · 2 GKP, 5 DEF, 5 MID, 3 FWD · max 3 per club. `,
      locked.size ? `${locked.size} locked. ` : '',
      excluded.size ? `${excluded.size} excluded. ` : '',
      'Click any player in the result to lock, exclude or swap him.'),
    (locked.size || excluded.size)
      ? el('div', { class: 'chiprow', style: 'margin-top:0.5rem' },
          [...locked].map((id) => el('button', { class: 'chip on', onClick: () => { locked.delete(id); setState({ locked: [...locked] }); renderControls(); run(); } }, `🔒 ${byId.get(id)?.web_name || id} ✕`)),
          [...excluded].map((id) => el('button', { class: 'chip', onClick: () => { excluded.delete(id); setState({ excluded: [...excluded] }); renderControls(); run(); } }, `🚫 ${byId.get(id)?.web_name || id} ✕`)),
        )
      : null,
  );
}

/* ------------------------------------------------------------------ *
 * run the optimiser
 * ------------------------------------------------------------------ */
function run() {
  recompute();
  renderControls();
  setKids(output, el('p', { class: 'loading' }, 'Solving…'));

  // Yield to the browser so the "Solving…" state actually paints before the
  // local search blocks the main thread.
  setTimeout(() => {
    const t0 = performance.now();
    try {
      result = optimiseSquad(rows, {
        budget, horizon, riskAversion, benchWeight,
        lockedIds: [...locked], excludedIds: [...excluded],
      });
    } catch (err) {
      setKids(output, el('div', { class: 'banner err' }, err.message));
      return;
    }
    const ms = Math.round(performance.now() - t0);
    if (result) applyManualXi();
    if (!result) {
      setKids(output, el('div', { class: 'banner err' }, 'No legal squad found. Try raising the budget or unlocking a player.'));
      return;
    }
    renderResult(ms);
  }, 20);
}

/**
 * Overlay the user's dragged XI onto a fresh solve. A saved selection only
 * applies while it still describes this exact 15 and a legal XI, so changing
 * the budget or locking a player quietly reverts to the optimal XI rather
 * than rendering a stale team.
 */
function applyManualXi() {
  if (!manualXi) return;
  const split = splitXI(result.squad, manualXi);
  if (!split) { manualXi = null; setState({ manualXi: null }); return; }
  Object.assign(result, split);
}

function commitSwap(outId, incId) {
  const byIdSquad = new Map(result.squad.map((p) => [p.id, p]));
  const out = byIdSquad.get(outId), inc = byIdSquad.get(incId);
  if (!canSwap(out, inc, result.xi)) return false;
  manualXi = result.xi.map((p) => (p === out ? inc : p)).map((p) => p.id);
  setState({ manualXi });
  applyManualXi();
  renderResult(lastMs);
  return true;
}

/**
 * One drag implementation for mouse and touch via Pointer Events. A mouse
 * drags as soon as it moves; a finger has to hold first, so that scrolling
 * the page past the pitch doesn't pick a player up by accident.
 */
const HOLD_MS = 400;   // touch: how long to hold before the shirt lifts
const MOVE_PX = 5;     // mouse: movement before it counts as a drag
const SCROLL_PX = 10;  // touch: movement that means "scroll", not "hold"

function makeDraggable(node, player) {
  node.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button > 0) return;
    const touch = ev.pointerType === 'touch';
    const x0 = ev.clientX, y0 = ev.clientY;
    let dragging = false, hold = null, lastTarget = null;

    // A shirt that stays put while the pointer moves gives no sense of having
    // picked anything up. A ghost — a clone that tracks the pointer — makes the
    // gesture legible: you can see who you are carrying and where they will land.
    let ghost = null;
    const placeGhost = (x, y) => {
      if (ghost) ghost.style.transform = `translate3d(${x - ghost._ox}px, ${y - ghost._oy}px, 0)`;
    };

    const start = () => {
      if (dragging) return;
      dragging = true;
      node.classList.add('dragging');

      const r = node.getBoundingClientRect();
      ghost = node.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.classList.remove('dragging');
      ghost.style.width = `${r.width}px`;
      ghost.style.height = `${r.height}px`;
      ghost.style.left = '0';
      ghost.style.top = '0';
      // Carry the shirt from the point it was grabbed, not from its corner.
      ghost._ox = x0 - r.left;
      ghost._oy = y0 - r.top;
      document.body.appendChild(ghost);
      placeGhost(x0, y0);

      markTargets(player);
    };

    if (touch) hold = setTimeout(start, HOLD_MS);

    // While a drag is live the page must not scroll under the finger. This has
    // to be a non-passive listener or preventDefault is ignored; it is added
    // per-drag rather than via touch-action so that a normal swipe starting on
    // a shirt still scrolls the page.
    const blockScroll = (e) => { if (dragging) e.preventDefault(); };
    document.addEventListener('touchmove', blockScroll, { passive: false });

    const move = (e) => {
      const dx = Math.abs(e.clientX - x0), dy = Math.abs(e.clientY - y0);
      if (!dragging) {
        // Before the hold completes, a moving finger means the user is
        // scrolling the page — not picking a player up.
        if (touch && (dx > SCROLL_PX || dy > SCROLL_PX)) return cancel();
        if (!touch && (dx > MOVE_PX || dy > MOVE_PX)) start();
        if (!dragging) return;
      }
      placeGhost(e.clientX, e.clientY);
      const t = shirtUnder(e.clientX, e.clientY);
      if (t !== lastTarget) {
        lastTarget?.classList.remove('drop-hot');
        if (t?.classList.contains('drop-ok')) t.classList.add('drop-hot');
        lastTarget = t;
      }
    };

    const up = (e) => {
      const wasDragging = dragging;
      const t = dragging ? shirtUnder(e.clientX, e.clientY) : null;
      cancel();
      if (wasDragging) {
        // Suppress the click that follows a drag, so releasing a shirt does
        // not also open the player modal.
        node.classList.add('was-dragged');
        setTimeout(() => node.classList.remove('was-dragged'), 0);
      }
      if (t?.dataset.pid && +t.dataset.pid !== player.id) {
        commitSwap(+t.dataset.pid, player.id) || commitSwap(player.id, +t.dataset.pid);
      }
    };

    function cancel() {
      clearTimeout(hold);
      dragging = false;
      node.classList.remove('dragging');
      ghost?.remove();
      ghost = null;
      lastTarget?.classList.remove('drop-hot');
      clearTargets();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('touchmove', blockScroll);
    }

    // Document-level: the pointer routinely leaves the shirt mid-drag, and
    // listeners bound to the shirt itself stop firing the moment it does.
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
  });
}

const shirtUnder = (x, y) => document.elementFromPoint(x, y)?.closest('.shirt') || null;

/** Outline every shirt this player may legally be exchanged with. */
function markTargets(player) {
  const byIdSquad = new Map(result.squad.map((p) => [p.id, p]));
  for (const node of document.querySelectorAll('.shirt[data-pid]')) {
    const other = byIdSquad.get(+node.dataset.pid);
    if (!other || other === player) continue;
    const legal = canSwap(other, player, result.xi) || canSwap(player, other, result.xi);
    node.classList.add(legal ? 'drop-ok' : 'drop-no');
  }
}

function clearTargets() {
  for (const node of document.querySelectorAll('.shirt'))
    node.classList.remove('drop-ok', 'drop-no', 'drop-hot');
}

function renderResult(ms) {
  lastMs = ms;
  const { squad, xi, bench, captain, vice, formation, cost, remaining, projected } = result;
  const check = validate(squad, budget);

  const shirt = (p, isCap, isVice, slot = null) => {
    const node = el('div', {
    class: `shirt ${isCap ? 'cap' : ''}`,
    'data-pid': p.id,
    title: `${p.first_name} ${p.second_name} — ${teams[p.team]?.name}`,
    onClick: (e) => { if (!e.currentTarget.classList.contains('was-dragged')) showPlayer(p); },
  },
    slot ? el('span', { class: 'slot' }, slot) : null,
    isCap ? el('span', { class: 'arm' }, 'C') : isVice ? el('span', { class: 'arm vice' }, 'V') : null,
    el('span', { class: 'nm' }, p.web_name),
    el('span', { class: 'cl' }, teams[p.team]?.short_name || ''),
    el('span', { class: 'pr' }, fmt.price(p.now_cost)),
    el('span', { class: 'pt' }, fmt.pts(p.proj)),
    );
    makeDraggable(node, p);
    return node;
  };

  const pitchRow = (pos) => {
    const ps = xi.filter((p) => p.element_type === pos);
    return ps.length ? el('div', { class: 'pitch-row' }, ps.map((p) => shirt(p, p === captain, p === vice))) : null;
  };

  setKids(output, 
    el('div', { class: 'tiles' },
      el('div', { class: 'tile accent' }, el('span', { class: 'k' }, `Projected ${horizon} GW`), el('span', { class: 'v' }, fmt.pts(projected)), el('span', { class: 's' }, 'starting XI + captain')),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Cost'), el('span', { class: 'v' }, fmt.price(cost)), el('span', { class: 's' }, `${fmt.price(remaining)} left`)),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Formation'), el('span', { class: 'v' }, formation), el('span', { class: 's' }, `captain ${captain?.web_name || '—'}`)),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Solve time'), el('span', { class: 'v' }, `${ms}ms`), el('span', { class: 's' }, 'randomised greedy + local search')),
    ),
    check.ok ? null : el('div', { class: 'banner err' }, check.errors.join('; ')),
    compareCard(result),
    el('div', { class: 'card' },
      el('div', { class: 'row between' },
        el('h2', {}, 'Suggested squad'),
        el('div', { class: 'btnrow' },
          el('button', { onClick: saveSquad }, 'Save as my squad'),
          el('button', { onClick: copyList }, 'Copy list'),
          manualXi ? el('button', { class: 'ghost', onClick: () => {
            manualXi = null; setState({ manualXi: null });
            const best = bestXI(result.squad);
            Object.assign(result, best);
            renderResult(lastMs);
          } }, 'Reset to optimal XI') : null,
        ),
      ),
      el('div', { class: 'pitch' },
        [1, 2, 3, 4].map(pitchRow).filter(Boolean),
        el('div', { class: 'bench-strip' }, (() => {
          let sub = 0;
          return bench.map((p) => shirt(p, false, false,
            p.element_type === 1 ? POS[p.element_type] : `${++sub} · ${POS[p.element_type]}`));
        })()),
      ),
    ),
    el('div', { class: 'card' },
      el('h2', {}, 'Squad detail'),
      el('div', { class: 'tablewrap' },
        el('table', { class: 'players' },
          // One definition per column drives BOTH the header and the cell, so a
          // heading cannot drift out of alignment with the values under it —
          // which is what happened when only the cells carried a class.
          el('thead', {}, el('tr', {}, SQUAD_COLUMNS(horizon).map((c) => el('th', { class: c.cls }, c.label)))),
          el('tbody', {}, squad.map((p) =>
            el('tr', { class: xi.includes(p) ? 'picked' : '', style: 'cursor:pointer', onClick: () => showPlayer(p) },
              ...SQUAD_COLUMNS(horizon).map((c) => el('td', { class: c.cls + (c.extra ? ` ${c.extra}` : '') }, c.cell(p)))))),
        ),
      ),
      fdrLegend(),
      el('p', { class: 'hint' }, 'Highlighted rows are the starting XI; the rest is your bench.'),
      el('p', { class: 'hint' }, manualXi
        ? 'Manual XI — your swaps are saved. Re-optimising restores the suggested team.'
        : 'Drag a player onto another to swap them — hold to pick one up on a phone. Keepers swap only with the reserve keeper.'),
    ),
  );
}

/**
 * What one free transfer can actually achieve.
 *
 * Separate from the squad comparison above, and deliberately so: the optimiser
 * rebuilds from scratch, which is a benchmark, while this answers the question
 * you can actually act on in a normal week. It returns ONE candidate, because a
 * list of five marginal swaps invites you to make all five, and you have one
 * transfer.
 */
let lastAdvice = null;

function actionableCard(mine, mineIds) {
  // Bank and free transfers are the Transfers page's controls, not this page's.
  // Read them from shared Classic state so both pages agree, and fall back to
  // the conservative case — no money, one transfer — rather than inventing
  // headroom the owner may not have.
  const cstate = getState();
  const bank = cstate.bank ?? 0;
  const freeTransfers = cstate.freeTransfers ?? 1;

  const rec = recommendedHorizon({ squad: mine, freeTransfers });
  /* A transfer decided now cannot score from a gameweek whose deadline has
     already gone, so its value is measured from the first one it can affect —
     not from wherever the live projection happens to start. */
  const fromEvent = actionableEvent(d.boot.events) ?? undefined;
  const rowsFor = (h) => projectAll(d.boot, d.fixtures, { horizon: h, riskAversion, fromEvent }).rows;
  const cache = new Map();
  const at = (h) => {
    if (!cache.has(h)) cache.set(h, rowsFor(h));
    return cache.get(h);
  };
  const gainAt = (move, h) => {
    const byH = new Map(at(h).map((r) => [r.id, r]));
    const sq = mineIds.map((id) => byH.get(id)).filter(Boolean);
    if (sq.length !== 15) return 0;
    const inc = byH.get(move.in.id);
    if (!inc) return 0;
    const base = scoreSquad(sq, { horizon: h, riskAversion });
    const trial = sq.filter((p) => p.id !== move.out.id).concat(inc);
    return scoreSquad(trial, { horizon: h, riskAversion }) - base;
  };

  const res = suggestTransfers(mineIds, at(rec.horizon), {
    bank, freeTransfers, horizon: rec.horizon, riskAversion, maxSuggestions: 12,
  });
  if (res.error) {
    return el('div', {}, el('h3', {}, 'This week'), el('p', { class: 'hint' }, res.error));
  }
  const hit = freeTransfers >= 1 ? 0 : 4;
  const best = bestMove(res.singles, gainAt, { hit });
  /* Published so the rating card can state the same recommended action rather
     than deriving a second, possibly contradictory one. */
  lastAdvice = { advice: best, rowsAt: at, bank, freeTransfers };

  const head = el('div', {},
    el('h3', {}, 'This week'),
    el('p', { class: 'hint' }, `Planning over ${rec.horizon} gameweeks. ${rec.why}`));

  if (!best || best.verdict === 'HOLD') {
    return el('div', { class: 'advice hold' }, head,
      el('p', { class: 'advice-verdict' }, 'HOLD'),
      el('p', {}, best
        ? `The best available move is ${best.move.out.web_name} → ${best.move.in.web_name}, worth `
          + `${best.gain >= 0 ? '+' : ''}${best.gain.toFixed(1)} over ${rec.horizon} gameweeks — `
          + `${best.reasons[0]}.`
        : 'No legal move improves this squad.'),
      el('p', { class: 'hint' }, 'A free transfer can be banked, so a move has to beat the player you own, '
        + 'the model\'s error and the value of keeping the transfer. Nothing here does.'));
  }

  const m = best.move;
  return el('div', { class: `advice ${best.verdict === 'STRONG TRANSFER' ? 'strong' : 'good'}` }, head,
    el('p', { class: 'advice-verdict' }, best.verdict),
    el('p', { class: 'advice-move' },
      el('strong', {}, m.out.web_name), ' → ', el('strong', {}, m.in.web_name),
      el('span', { class: 'dim' }, `  ${hit ? `−${hit} hit` : 'free transfer'}`)),
    el('div', { class: 'tiles' }, best.cross.gains.map((g) => el('div', { class: 'tile' },
      el('span', { class: 'k' }, `Next ${g.horizon}`),
      el('span', { class: 'v' }, `${g.gain >= 0 ? '+' : ''}${g.gain.toFixed(1)}`)))),
    el('p', { class: 'hint' }, `Confidence ${best.confidence}. ${best.reasons.join('; ')}.`));
}

/**
 * Column geometry for the squad detail table.
 *
 * `cls` is applied identically to the `th` and the `td`, which is the whole
 * point: alignment is a property of the column, not of the two places it
 * happens to be written. Numbers are centred per the owner's preference;
 * player and fixtures stay left, because both are variable-width content that
 * reads badly centred.
 */
const SQUAD_COLUMNS = (horizon) => [
  { label: 'Pos', cls: 'col-c', cell: (p) => posPill(p) },
  { label: 'Player', cls: 'col-l name', cell: (p) => [p.web_name, el('span', { class: 'club' }, teams[p.team]?.short_name), ' ', statusBadge(p), ' ', penBadge(p)] },
  { label: 'Price', cls: 'col-c', cell: (p) => fmt.price(p.now_cost) },
  { label: `Proj ${horizon}GW`, cls: 'col-c', extra: 'proj', cell: (p) => fmt.pts(p.proj) },
  { label: 'Pts/£m', cls: 'col-c', cell: (p) => fmt.pts(p.value) },
  { label: 'Own %', cls: 'col-c', cell: (p) => `${p.selected_by_percent}%` },
  { label: 'Fixtures', cls: 'col-l', cell: (p) => fdrTicker(p.fixtures, teams, Math.min(horizon, 6), ctx.fromEvent) },
];

function saveSquad() {
  setState({ manualSquad: result.squad.map((p) => p.id) });
  output.prepend(el('div', { class: 'banner ok' }, 'Saved to this browser. The Dashboard and Transfers pages will now use it.'));
}

function copyList() {
  const text = result.squad
    .sort((a, b) => a.element_type - b.element_type || b.proj - a.proj)
    .map((p) => `${POS[p.element_type]}  ${p.web_name} (${teams[p.team]?.short_name}) ${fmt.price(p.now_cost)}`)
    .join('\n');
  navigator.clipboard?.writeText(`${text}\n\nTotal: ${fmt.price(result.cost)}`);
  output.prepend(el('div', { class: 'banner ok' }, 'Squad copied to the clipboard.'));
}

function showPlayer(p) {
  const isLocked = locked.has(p.id);
  modal(p.web_name, el('div', {},
    el('p', { class: 'row' }, posPill(p), el('strong', {}, `${p.first_name} ${p.second_name}`), el('span', { class: 'dim' }, teams[p.team]?.name), statusBadge(p), penBadge(p)),
    p.news ? el('p', { class: 'badge warn', style: 'display:block;padding:0.4rem 0.6rem' }, p.news) : null,
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Price'), el('span', { class: 'v' }, fmt.price(p.now_cost))),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, `Proj ${horizon}GW`), el('span', { class: 'v' }, fmt.pts(p.proj))),
      el('div', { class: 'tile' }, el('span', { class: 'k' }, 'Owned'), el('span', { class: 'v' }, `${p.selected_by_percent}%`)),
    ),
    breakdown(p.parts || {}),
    el('div', { class: 'btnrow', style: 'margin-top:1rem' },
      el('button', { class: isLocked ? '' : 'primary', onClick: () => { if (isLocked) locked.delete(p.id); else locked.add(p.id); setState({ locked: [...locked] }); document.querySelector('.modal-back')?.remove(); run(); } },
        isLocked ? 'Unlock' : 'Lock into squad'),
      el('button', { class: 'danger', onClick: () => { excluded.add(p.id); locked.delete(p.id); setState({ excluded: [...excluded], locked: [...locked] }); document.querySelector('.modal-back')?.remove(); run(); } },
        'Never pick him'),
    ),
  ));
}

recompute();
run();

/* ------------------------------------------------------------------ *
 * your squad vs the optimiser's
 * ------------------------------------------------------------------ */
/**
 * Side by side, both labelled, with the difference stated once at the top.
 *
 * The distinction this card exists to make: the optimiser answers "what would
 * the model pick from scratch today", which is NOT the same question as "what
 * should I change". A fifteen-player difference is normal and is not a
 * fifteen-transfer instruction. So differences are listed as differences, and
 * nothing here is phrased as a recommendation — the Transfers page owns that,
 * and it has to clear a much higher bar before it says move.
 */
/**
 * The squad rating.
 *
 * Two headline numbers from one machinery, differing only in the window they
 * are measured over. **Squad Quality** runs over eight actionable gameweeks, so
 * a two-fixture swing cannot make a good squad look bad. **Next-5 Outlook**
 * runs over five, which is the window a transfer is actually planned in. The
 * gap between them is the fixture signal, and it is more useful than either
 * number alone: a squad rated 88 for quality and 79 for outlook has good
 * players in a bad run, which is a hold, not a rebuild.
 *
 * Every line shown here comes out of js/rating.js. Nothing is narrated that the
 * model did not produce, and the recommended action is the transfer adviser's
 * own verdict rather than a second opinion invented for the card.
 */
function ratingCard({ mine, rowsAt, bank, freeTransfers, advice }) {
  const at = (h) => {
    const m = new Map(rowsAt(h).map((r) => [r.id, r]));
    return mine.map((p) => m.get(p.id)).filter(Boolean);
  };
  const short = at(5);
  const long = at(8);
  if (short.length !== 15 || long.length !== 15) return null;

  const outlook = rateSquad(short, { pool: rowsAt(5), bank, freeTransfers });
  const quality = rateSquad(long, { pool: rowsAt(8), bank, freeTransfers });
  if (outlook.error || quality.error) return null;

  const bar = (label, v, hint) => el('div', { class: 'ratebar' },
    el('span', { class: 'k' }, label),
    el('span', { class: 'track' }, el('span', { class: 'fill', style: `width:${v}%` })),
    el('span', { class: 'v' }, String(v)),
    hint ? el('span', { class: 's' }, hint) : null,
  );

  const d = outlook.dims;
  const pos = outlook.parts.positional;
  const cap = outlook.parts.captain;
  const swing = outlook.overall - quality.overall;

  return el('div', { class: 'card' },
    el('div', { class: 'row between' }, el('h2', {}, 'Squad rating'), horizonBadge('next5')),
    el('div', { class: 'tiles' },
      el('div', { class: 'tile accent' },
        el('span', { class: 'k' }, 'Squad quality'),
        el('span', { class: 'v' }, `${quality.overall}`),
        el('span', { class: 's' }, 'underlying, over 8 gameweeks')),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'Next-5 outlook'),
        el('span', { class: 'v' }, `${outlook.overall}`),
        el('span', { class: 's' }, swing === 0 ? 'fixtures are neutral'
          : `fixtures ${swing > 0 ? 'help' : 'hurt'} by ${Math.abs(swing)}`)),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'Captain'),
        el('span', { class: 'v' }, cap ? cap.web_name : '—'),
        el('span', { class: 's' }, cap ? `${fmt.pts(cap.proj)} over 5 GW` : '')),
    ),
    el('div', { class: 'ratebars' },
      bar('Best XI', d.xi),
      bar('Captaincy', d.captaincy),
      bar('GK', d.gk, `£${(pos.gk.spend / 10).toFixed(1)}m`),
      bar('DEF', d.def, `£${(pos.def.spend / 10).toFixed(1)}m`),
      bar('MID', d.mid, `£${(pos.mid.spend / 10).toFixed(1)}m`),
      bar('FWD', d.fwd, `£${(pos.fwd.spend / 10).toFixed(1)}m`),
      bar('Depth', d.depth, `${fmt.pts(outlook.parts.depth.perAbsence)} lost per absence`),
      bar('Minutes security', d.minutes),
      bar('Flexibility', d.flexibility, `£${(bank / 10).toFixed(1)}m banked`),
    ),
    el('p', { class: 'hint' },
      `Each line is measured against the strongest legal alternative the same money could buy — `
      + `100 means that money is already working as hard as it can. `
      + `Positional scores compare each line with the best line available for what you spent on it.`),
    el('div', { class: 'row between' },
      el('p', {}, el('strong', {}, 'Biggest strength: '), `${outlook.strongest.label} (${outlook.strongest.score})`),
      el('p', {}, el('strong', {}, 'Biggest weakness: '), `${outlook.weakest.label} (${outlook.weakest.score})`),
    ),
    /* The weakest line is called out separately from the weakest dimension.
       They are different questions: flexibility is fixed with money, a weak
       line is fixed with a transfer, and only one of those is a player problem. */
    outlook.weakestLine.key !== outlook.weakest.key
      ? el('p', { class: 'hint' },
        `Weakest line: ${outlook.weakestLine.label} (${outlook.weakestLine.score}) — `
        + `£${(pos[outlook.weakestLine.key].spend / 10).toFixed(1)}m returning `
        + `${fmt.pts(pos[outlook.weakestLine.key].proj)} where the best line for that money returns `
        + `${fmt.pts(pos[outlook.weakestLine.key].achievable)}.`)
      : null,
    /* The action comes from the adviser that already decided it, so the card
       cannot recommend a move the transfer engine would have refused. */
    advice && advice.verdict !== 'HOLD'
      ? el('p', {},
        el('strong', {}, 'Recommended action: '),
        `${advice.verdict} — ${advice.move.out.web_name} → ${advice.move.in.web_name}, `
        + `${fmt.signed(advice.gain)} over 5 GW, confidence ${advice.confidence.toLowerCase()}`)
      : el('p', {},
        el('strong', {}, 'Recommended action: HOLD. '),
        `Weakest line is ${outlook.weakestLine.label} (${outlook.weakestLine.score}), but no move clears the bar this week.`),
  );
}

function compareCard(result) {
  const { ids: mineIds, source } = resolveSquadIds(d.entry, getState());
  if (mineIds.length !== 15) {
    return el('div', { class: 'card' },
      el('div', { class: 'row between' }, el('h2', {}, 'Compare with my squad'), horizonBadge(horizon === 5 ? 'next5' : `next${horizon}`)),
      el('p', { class: 'hint' },
        source === 'none'
          ? 'No squad of your own yet. Save one here, or wait for your FPL picks to publish after the first deadline, and this will compare the two.'
          : `Your squad has ${mineIds.length} of 15 recognised players, so a like-for-like comparison would mislead.`));
  }

  const mine = mineIds.map((id) => byId.get(id)).filter(Boolean);
  if (mine.length !== 15) {
    return el('div', { class: 'card' },
      el('div', { class: 'row between' }, el('h2', {}, 'Compare with my squad'), horizonBadge(horizon === 5 ? 'next5' : `next${horizon}`)),
      el('p', { class: 'hint' }, 'Some of your players are missing from the current dataset, so the comparison is not reliable this refresh.'));
  }

  const mineXI = bestXI(mine);
  const mineScore = scoreSquad(mine, { horizon, riskAversion });

  /* The squad you can actually reach, and what each extra transfer buys.
   *
   * The whole ladder is solved, not just the chosen rung: the interesting
   * number is almost never the total, it is where the gain stops growing.
   * Each solve is single-digit milliseconds, so there is no reason to make the
   * reader move a control to find that out. */
  const cstate = getState();
  const bank = cstate.bank ?? 0;
  const solveOpts = { horizon, riskAversion, benchWeight, excludedIds: [...excluded] };
  const ladder = [0, 1, 2, 3, 4, 5].map((n) =>
    optimiseWithinTransfers(mineIds, rows, { bank, transfers: n, ...solveOpts }));
  const reach = ladder[Math.min(plannedTransfers, ladder.length - 1)];

  /* Seeded with the reachable squads so the benchmark can never read LOWER
     than a squad reachable under a transfer limit — which is nonsense on its
     face and does happen: randomised construction alone left 1.6 points on the
     table on one dataset. See optimiseSquad's seedSquads. */
  const ceiling = optimiseSquad(rows, {
    budget: squadCost(mine) + bank,
    ...solveOpts,
    lockedIds: [...locked],
    seedSquads: ladder.map((r) => r.squad).filter(Boolean),
  }) || result;

  const optScore = scoreSquad(ceiling.squad, { horizon, riskAversion });
  const delta = optScore - mineScore;

  const optIds = new Set(ceiling.squad.map((p) => p.id));
  const mineSet = new Set(mine.map((p) => p.id));
  const out = mine.filter((p) => !optIds.has(p.id)).sort((a, b) => b.proj - a.proj);
  const inc = ceiling.squad.filter((p) => !mineSet.has(p.id)).sort((a, b) => b.proj - a.proj);

  const openPlayer = (p) => playerCard(p, { teams, fixturesFor, horizon, fromEvent: ctx?.nextEvent ?? 1 });
  const pitchFor = (squad) => {
    const { xi, bench } = bestXI(squad);
    return squadPitch({
      xi, bench, teams,
      value: (p) => fmt.pts(p.proj),
      sub: (p) => fmt.price(p.now_cost),
      onPlayer: openPlayer,
    });
  };

  return el('div', { class: 'card' },
    el('div', { class: 'row between' }, el('h2', {}, 'Compare with my squad'), horizonBadge(horizon === 5 ? 'next5' : `next${horizon}`)),
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, `Your squad · ${horizon} GW`),
        el('span', { class: 'v' }, fmt.pts(mineScore)),
        el('span', { class: 's' }, source === 'fpl' ? 'from your FPL team' : 'from your saved squad')),
      el('div', { class: `tile ${reach.gain > 0 ? 'accent' : ''}` },
        el('span', { class: 'k' }, `With ${plannedTransfers} transfer${plannedTransfers === 1 ? '' : 's'}`),
        el('span', { class: 'v' }, fmt.pts(reach.score)),
        el('span', { class: 's' }, reach.transfersUsed
          ? `${fmt.signed(reach.gain)} · ${reach.transfersUsed} move${reach.transfersUsed === 1 ? '' : 's'}`
          : 'nothing worth doing')),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'Unreachable ceiling'),
        el('span', { class: 'v' }, fmt.pts(optScore)),
        el('span', { class: 's' }, `${out.length} player${out.length === 1 ? '' : 's'} differ · ${fmt.signed(delta)}`)),
    ),
    el('p', { class: 'hint' },
      `The squad above is the best one you can REACH with ${plannedTransfers} transfer`
      + `${plannedTransfers === 1 ? '' : 's'} and ${fmt.price(bank)} in the bank — every move is one you could make. `
      + 'The ceiling beside it is built from scratch and costs a transfer per player changed, '
      + 'so it is a benchmark rather than a plan. No suggestion here takes a −4 hit; '
      + 'set the transfer count to what you have, or to what you would have after banking.'),

    /* Where the gain stops growing is the actual decision — banking a fourth
       transfer is only worth it if the fourth rung is meaningfully higher. */
    el('h3', {}, 'What each transfer buys'),
    el('div', { class: 'tablewrap' }, el('table', { class: 'players' },
      el('thead', {}, el('tr', {}, ...['Transfers', `Squad · ${horizon} GW`, 'Gain', 'Extra over previous', 'Moves'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ladder.map((r, n) => el('tr', { class: n === plannedTransfers ? 'picked' : '' },
        el('td', {}, String(n)),
        el('td', { class: 'num' }, fmt.pts(r.score)),
        el('td', { class: 'num' }, n === 0 ? '—' : fmt.signed(r.gain)),
        el('td', { class: 'num' }, n === 0 ? '—' : fmt.signed(r.gain - ladder[n - 1].gain)),
        el('td', {}, r.moves.length
          ? r.moves.map((m) => `${m.out.web_name} → ${m.in.web_name}`).join(', ')
          : '—'),
      ))),
    )),

    reach.moves.length
      ? el('div', {},
          el('h3', {}, `Your ${reach.transfersUsed} move${reach.transfersUsed === 1 ? '' : 's'}`),
          el('div', {}, reach.moves.map((m) => el('div', { class: 'row between', style: 'padding:0.35rem 0.75rem;border-bottom:1px solid var(--border-soft)' },
            el('span', {}, el('strong', { class: 'down' }, m.out.web_name),
              el('span', { class: 'dim' }, ` ${teams[m.out.team]?.short_name} · ${fmt.price(m.out.now_cost)} · ${fmt.pts(m.out.proj)}`),
              ' → ',
              el('strong', { class: 'up' }, m.in.web_name),
              el('span', { class: 'dim' }, ` ${teams[m.in.team]?.short_name} · ${fmt.price(m.in.now_cost)} · ${fmt.pts(m.in.proj)}`)),
            el('span', { class: 'dim' }, fmt.signed(m.in.proj - m.out.proj)),
          ))),
          el('p', { class: 'hint' }, `Leaves ${fmt.price(reach.remaining)} in the bank.`))
      : null,

    el('div', { class: 'compare-grid' },
      el('div', { class: 'compare-col' },
        el('h3', {}, source === 'fpl' ? 'My FPL squad' : 'My saved squad'),
        pitchFor(mine)),
      el('div', { class: 'compare-col' },
        el('h3', {}, `Reachable with ${plannedTransfers}`),
        pitchFor(reach.squad)),
      el('div', { class: 'compare-col' },
        el('h3', {}, 'Unreachable ceiling'),
        pitchFor(ceiling.squad)),
    ),
    actionableCard(mine, mineIds),
    /* After actionableCard, which is what publishes the adviser's verdict. */
    lastAdvice ? ratingCard({ mine, ...lastAdvice }) : null,
    el('h3', {}, 'Every difference'),
    out.length
      ? el('div', { class: 'tablewrap' }, el('table', { class: 'players' },
        el('thead', {}, el('tr', {}, ...['In your squad only', 'Proj', 'In optimiser only', 'Proj', 'Difference'].map((h) => el('th', {}, h)))),
        el('tbody', {}, out.map((o, i) => {
          const n = inc[i];
          return el('tr', {},
            el('td', { onClick: () => openPlayer(o) }, `${o.web_name} (${teams[o.team]?.short_name || ''})`),
            el('td', {}, fmt.pts(o.proj)),
            el('td', n ? { onClick: () => openPlayer(n) } : {}, n ? `${n.web_name} (${teams[n.team]?.short_name || ''})` : '—'),
            el('td', {}, n ? fmt.pts(n.proj) : '—'),
            el('td', {}, n ? el('span', { class: n.proj - o.proj >= 0 ? 'up' : 'down' }, fmt.signed(n.proj - o.proj)) : '—'));
        }))))
      : el('p', { class: 'hint' }, 'Your squad already matches the optimiser exactly.'),
  );
}
