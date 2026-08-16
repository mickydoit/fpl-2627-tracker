import { loadAll, getState, setState, resolveSquadIds } from '../data.js';
import { projectAll, POS, SQUAD_RULES } from '../model.js';
import { optimiseSquad, validate, squadCost, bestXI, canSwap, splitXI } from '../optimiser.js';
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
let result = null;
let lastMs = 0;

let rows = [];
let ctx = null;
let byId = new Map();
const teams = Object.fromEntries(d.boot.teams.map((t) => [t.id, t]));

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

    const start = () => {
      if (dragging) return;
      dragging = true;
      node.classList.add('dragging');
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
          el('thead', {}, el('tr', {}, ['Pos', 'Player', 'Price', `Proj ${horizon}GW`, 'Pts/£m', 'Own %', 'Fixtures'].map((h) => el('th', {}, h)))),
          el('tbody', {}, squad.map((p) =>
            el('tr', { class: xi.includes(p) ? 'picked' : '', style: 'cursor:pointer', onClick: () => showPlayer(p) },
              el('td', {}, posPill(p)),
              el('td', { class: 'name' }, p.web_name, el('span', { class: 'club' }, teams[p.team]?.short_name), ' ', statusBadge(p), ' ', penBadge(p)),
              el('td', { class: 'num' }, fmt.price(p.now_cost)),
              el('td', { class: 'num proj' }, fmt.pts(p.proj)),
              el('td', { class: 'num' }, fmt.pts(p.value)),
              el('td', { class: 'num' }, `${p.selected_by_percent}%`),
              el('td', {}, fdrTicker(p.fixtures, teams, Math.min(horizon, 6), ctx.fromEvent)),
            ))),
        ),
      ),
      el('p', { class: 'hint' }, 'Highlighted rows are the starting XI; the rest is your bench.'),
      el('p', { class: 'hint' }, manualXi
        ? 'Manual XI — your swaps are saved. Re-optimising restores the suggested team.'
        : 'Drag a player onto another to swap them — hold to pick one up on a phone. Keepers swap only with the reserve keeper.'),
    ),
  );
}

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
