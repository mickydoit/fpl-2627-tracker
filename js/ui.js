/** Shared rendering helpers. */

import { POS } from './model.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const fmt = {
  price: (tenths) => `£${(tenths / 10).toFixed(1)}m`,
  pts: (n) => (Math.round(n * 10) / 10).toFixed(1),
  pct: (n) => `${(n * 100).toFixed(0)}%`,
  signed: (n) => (n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1)),
};

/**
 * Drops nulls, undefined and false from a child list.
 *
 * This matters more than it looks: the native `append` and `replaceChildren`
 * stringify null into the literal text "null" rather than ignoring it, so any
 * `cond ? el(...) : null` passed straight to them prints "null" on the page.
 * Always route children through here.
 */
const cleanKids = (kids) =>
  kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== '');

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of cleanKids(children)) {
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Null-safe replaceChildren. */
export function setKids(node, ...kids) {
  node.replaceChildren(...cleanKids(kids));
  return node;
}

/** Null-safe append. */
export function addKids(node, ...kids) {
  node.append(...cleanKids(kids));
  return node;
}

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- data freshness banner ---------- */
export function dataBar(meta) {
  const bar = el('div', { class: 'databar' });
  if (!meta || meta.source === 'missing') {
    bar.classList.add('seed');
    addKids(bar, 
      el('span', { class: 'dot' }),
      el('span', {}, 'No data yet — run the '),
      el('strong', {}, 'Refresh data'),
      el('span', {}, ' workflow in GitHub Actions to pull live FPL and ESPN data.'),
    );
    return bar;
  }
  if (meta.source === 'seed') bar.classList.add('seed');
  const age = meta.fetched_at ? (Date.now() - new Date(meta.fetched_at)) / 60000 : null;
  if (age !== null && age > 180) bar.classList.add('stale');

  const when = age === null ? 'unknown'
    : age < 1 ? 'just now'
    : age < 60 ? `${Math.round(age)} min ago`
    : `${(age / 60).toFixed(1)} h ago`;

  addKids(bar, 
    el('span', { class: 'dot' }),
    el('span', {}, meta.source === 'seed' ? 'Seed data — ' : 'Live data — '),
    el('strong', {}, `updated ${when}`),
    meta.player_count ? el('span', { class: 'dim' }, ` · ${meta.player_count} players`) : null,
    meta.current_gw ? el('span', { class: 'dim' }, ` · GW${meta.current_gw} in progress`) : null,
    !meta.current_gw && meta.next_gw ? el('span', { class: 'dim' }, ` · GW${meta.next_gw} next`) : null,
  );
  return bar;
}

/* ---------- countdown to the deadline ---------- */
export function countdown(node, iso) {
  if (!iso) { node.textContent = '—'; return; }
  const target = new Date(iso).getTime();
  const tick = () => {
    const diff = target - Date.now();
    if (diff <= 0) { node.textContent = 'Deadline passed'; return; }
    const d = Math.floor(diff / 864e5);
    const h = Math.floor((diff % 864e5) / 36e5);
    const m = Math.floor((diff % 36e5) / 6e4);
    const s = Math.floor((diff % 6e4) / 1000);
    node.textContent = d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;
  };
  tick();
  return setInterval(tick, 1000);
}

/* ---------- fixture difficulty ticker ---------- */
export function fdrTicker(fixtures, teams, horizon, fromEvent) {
  const wrap = el('span', { class: 'fdr' });
  const byGW = {};
  for (const f of fixtures) (byGW[f.event] ||= []).push(f);
  for (let gw = fromEvent; gw < fromEvent + horizon; gw++) {
    const fs = byGW[gw];
    if (!fs?.length) {
      addKids(wrap, el('span', { class: 'blank', title: `GW${gw}: blank` }, '—'));
      continue;
    }
    for (const f of fs) {
      const opp = teams[f.opponent];
      const label = opp ? (f.home ? opp.short_name.toUpperCase() : opp.short_name.toLowerCase()) : '?';
      addKids(wrap, 
        el('span', {
          'data-d': f.difficulty,
          class: f.home ? '' : 'away',
          title: `GW${gw} ${f.home ? 'vs' : 'at'} ${opp?.name || '?'} — difficulty ${f.difficulty}`,
        }, label),
      );
    }
  }
  return wrap;
}

/* ---------- availability badge ---------- */
export function statusBadge(p) {
  if (p.status === 'i') return el('span', { class: 'badge bad', title: p.news }, 'INJ');
  if (p.status === 's') return el('span', { class: 'badge bad', title: p.news }, 'SUS');
  if (p.status === 'u' || p.status === 'n') return el('span', { class: 'badge bad', title: p.news }, 'OUT');
  if (p.status === 'd') {
    const c = p.chance_of_playing_next_round;
    return el('span', { class: 'badge warn', title: p.news }, c === null || c === undefined ? '?' : `${c}%`);
  }
  return null;
}

export function penBadge(p) {
  if (p.penalties_order === 1) return el('span', { class: 'badge pen', title: p.penalties_text || 'First-choice penalty taker' }, 'PEN');
  return null;
}

export function posPill(p) {
  const code = POS[p.element_type];
  return el('span', { class: `pos ${code}` }, code);
}

/* ---------- projection breakdown ---------- */
export function breakdown(parts) {
  const rows = [
    ['Appearance', parts.appearance],
    ['Attacking', parts.attack],
    ['Clean sheet', parts.cleanSheet],
    ['Conceded', parts.conceded],
    ['Saves', parts.saves],
    ['Def. contrib.', parts.defcon],
    ['Bonus', parts.bonus],
    ['Cards', parts.cards],
  ].filter(([, v]) => typeof v === 'number' && Math.abs(v) > 0.005);

  const max = Math.max(0.5, ...rows.map(([, v]) => Math.abs(v)));
  const wrap = el('div', { class: 'breakdown' });
  for (const [label, v] of rows) {
    addKids(wrap, 
      el('div', { class: 'brk' },
        el('span', { class: 'lbl' }, label),
        el('span', { class: 'bar' }, el('i', { class: v < 0 ? 'neg' : '', style: `width:${(Math.abs(v) / max) * 100}%` })),
        el('span', { class: 'val' }, fmt.signed(v)),
      ),
    );
  }
  return wrap;
}

/* ---------- generic sortable table ---------- */
export function sortableTable({ columns, rows, initialSort, onRowClick, rowClass }) {
  let sortKey = initialSort?.key ?? columns[0].key;
  let asc = initialSort?.asc ?? false;

  const table = el('table', { class: 'players' });
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);

  const renderHead = () => {
    setKids(thead, 
      el('tr', {}, columns.map((c) =>
        el('th', {
          class: `${c.key === sortKey ? 'sorted' : ''} ${c.key === sortKey && asc ? 'asc' : ''}`,
          title: c.title || '',
          onClick: () => {
            if (sortKey === c.key) asc = !asc;
            else { sortKey = c.key; asc = !!c.ascDefault; }
            renderHead();
            renderBody();
          },
        }, c.label),
      )),
    );
  };

  const renderBody = () => {
    const col = columns.find((c) => c.key === sortKey);
    const get = col?.sortValue || col?.value || ((r) => r[sortKey]);
    const sorted = [...rows].sort((a, b) => {
      const av = get(a); const bv = get(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      }
      return asc ? av - bv : bv - av;
    });
    setKids(tbody, 
      ...sorted.slice(0, 400).map((r) => {
        const tr = el('tr', { class: rowClass ? rowClass(r) : '' },
          columns.map((c) => {
            const v = c.render ? c.render(r) : c.value ? c.value(r) : r[c.key];
            return el('td', { class: c.cls || '' }, v === null || v === undefined ? '' : v);
          }),
        );
        if (onRowClick) tr.addEventListener('click', () => onRowClick(r));
        return tr;
      }),
    );
    if (!sorted.length) {
      setKids(tbody, el('tr', {}, el('td', { colspan: columns.length, class: 'empty' }, 'No players match those filters.')));
    }
  };

  renderHead();
  renderBody();
  return { table, refresh: (next) => { rows = next; renderBody(); } };
}

/* ---------- modal ---------- */
export function modal(title, body) {
  const back = el('div', { class: 'modal-back', onClick: (e) => { if (e.target === back) back.remove(); } });
  const box = el('div', { class: 'modal' },
    el('button', { class: 'close', onClick: () => back.remove() }, 'Close'),
    el('h2', {}, title),
    body,
  );
  back.append(box);
  document.body.append(back);
  const esc = (e) => { if (e.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  return back;
}

/**
 * The key to the fixture colours.
 *
 * Built from the same `data-d` values that fdrTicker() stamps on every chip,
 * so the legend and the chips are styled by one CSS rule set and cannot
 * disagree. Inventing a second palette here is exactly how a legend ends up
 * lying about the thing it explains.
 */
export function fdrLegend() {
  const levels = [
    [1, 'Very favourable'],
    [2, 'Favourable'],
    [3, 'Neutral'],
    [4, 'Difficult'],
    [5, 'Very difficult'],
  ];
  return el('div', { class: 'fdrkey' },
    el('span', { class: 'fdrkey-t' }, 'Fixture key'),
    el('span', { class: 'fdr' }, levels.map(([d, label]) =>
      el('span', { 'data-d': String(d), title: `Difficulty ${d} — ${label}` }, String(d)))),
    el('span', { class: 'fdrkey-l' }, 'easier → harder'),
    el('span', { class: 'fdrkey-c' }, 'UPPERCASE = home · lowercase = away'),
  );
}

/**
 * Which horizon a number is measured over.
 *
 * The app shows three at once — next gameweek for a lineup, five for a
 * transfer, rest of season for squad quality — and they were distinguishable
 * only by reading the small print under each tile, or not at all. A projection
 * without its horizon is not interpretable, so every card that shows one now
 * states it in the same place, in the same words.
 */
export function horizonBadge(kind) {
  const label = {
    gw: 'Next gameweek',
    next5: 'Next 5 gameweeks',
    next3: 'Next 3 gameweeks',
    next8: 'Next 8 gameweeks',
    ros: 'Rest of season',
  }[kind] || kind;
  return el('span', { class: `hz hz-${kind}`, title: `These numbers are projected over: ${label.toLowerCase()}` }, label);
}

/**
 * The horizon badge, but choosable.
 *
 * A projection is meaningless without its window, and the right window depends
 * on the question — one gameweek to pick a lineup, five to judge a transfer,
 * ten to plan around a fixture swing. Rather than fix one and label it, this
 * lets the reader move it and re-reads everything underneath.
 *
 * Styled as the badge it replaces so the horizon still reads at a glance when
 * nobody is touching it.
 */
/**
 * The window that means "everything still to play".
 *
 * A season is 38 gameweeks, so 38 is the widest window any picker can offer —
 * but it must never render as "Next 38 gameweeks", which reads as a countdown
 * from a fixed point rather than as the rest of the season. Labelled and
 * coloured like horizonBadge('ros') so the two are indistinguishable at rest.
 */
export const SEASON_HORIZON = 38;

/* horizonPicker, the <select> that used to sit here, is gone — every caller now
   uses `cycler` / `horizonCycler` below. Keeping both would leave two ways to
   build the same control and let a select drift back in. */


/* ------------------------------------------------------------------ *
 * page composition
 * ------------------------------------------------------------------ */

/**
 * A section: a named group with its own control, and a body that visibly
 * belongs to it.
 *
 * The unit of hierarchy across the tracker. A header bar and its body share one
 * border, so "which control drives which numbers" and "where does this group
 * end" are answered by structure rather than by proximity — the previous build
 * floated a label left and a picker right on a bare line and neither question
 * had an answer.
 *
 * The name is a cyan pill on ink, which is Figma's own treatment for a section
 * label (`Golden Boot` 83:324, `Transfer` 236:99).
 *
 * @param {string} name          shown in the pill
 * @param {Node|Node[]} control  the control this section owns, if any
 * @param {string} hint          tooltip; explanation belongs here, not on the page
 * @param {boolean} flush        body has no padding — for pitches, tables, lists
 * @returns {{wrap: Node, body: Node, head: Node}}
 */
export function section(name, { control = null, hint = '', flush = false } = {}) {
  const body = el('div', { class: `secbody ${flush ? 'flush' : ''}` });
  const ctl = el('div', { class: 'secctl' }, control);
  const head = el('div', { class: 'sechead' },
    el('span', { class: 'seclabel', title: hint }, name),
    ctl);
  /* An unnamed section has no header — the pitches are the case, they are
     introduced by the pill above them rather than by a label of their own.
     Marking it here means the stylesheet can drop the room reserved above and
     below a heading that was never drawn, instead of every caller removing the
     node and living with the gap it left behind. */
  const wrap = el('section', { class: `sec ${name ? '' : 'nohead'}` }, head, body);
  return { wrap, body, head, ctl };
}

/**
 * One cell of a metrics strip: value over caption.
 *
 * Figma runs these at 72x39 on a 440 canvas — small enough to read as context
 * rather than compete with whatever the page is actually about. `accent` is the
 * gold-to-sage gradient it reserves for the one that matters most (83:357);
 * everything else is flat cyan (83:227).
 */
export function metric(value, caption, { tone = '', hint = '' } = {}) {
  return el('div', { class: `metric ${tone}`, title: hint },
    el('span', { class: 'mv' }, value),
    el('span', { class: 'mc' }, caption));
}

/** 4,296,658 -> 4.3M. Seven digits do not fit a pill; this is what gets read. */
export function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : v.toLocaleString('en-GB');
}


/**
 * A window selector you step through rather than open.
 *
 * The Figma has no dropdown: it has a pill with arrows either side and the
 * current option in the middle, and you cycle. That is a better fit for four
 * ordered values than a select — the options ARE a sequence, and stepping
 * along one keeps the reader's eye on the board rather than in a menu.
 *
 * The end arrows disappear at the ends rather than wrapping. Wrapping from
 * "next 8" back to "next gameweek" on a forward press reads as a glitch, and
 * the reference frame draws the first option with only a forward arrow.
 *
 * @param {number[]} options ascending gameweek counts
 */
/**
 * A value you step through rather than open.
 *
 * The Figma has no dropdown anywhere: it has a pill with the current option in
 * the middle and an arrow either side. That is a better fit than a select for
 * a short ordered list — the options ARE a sequence, so stepping along one
 * keeps the reader's eye on the page instead of in a menu, and the current
 * value stays readable at display size instead of shrinking to fit a control.
 *
 * The end arrows disable rather than wrap. Wrapping from the last option back
 * to the first on a forward press reads as a glitch.
 *
 * NOT for long lists. Reaching one of twenty clubs, or one of fifteen league
 * sizes, would take up to nineteen clicks — those keep their dropdown, which is
 * the right control for picking one of many rather than moving along a scale.
 *
 * @param {*} value              the current value, compared with ===
 * @param {{value:*, label:string}[]} options  in the order they step
 * @param {(v:*) => void} onChange
 */
export function cycler(value, options, onChange, { title = '', compact = false } = {}) {
  const opts = options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o));
  /* Redraws itself in place. A <select> shows its new value for free; a pill
     built from the old one does not, and several of these sit in one-shot
     renders with no repaint function to call. Swapping itself means a caller
     only has to react to the change, never to re-render the control — and a
     caller that does repaint simply replaces the node again, harmlessly. */
  let node;
  const build = (v) => {
    const at = opts.findIndex((o) => o.value === v);
    const i = at < 0 ? 0 : at;
    const step = (delta) => {
      const next = opts[i + delta];
      if (!next) return;
      const fresh = build(next.value);
      node.replaceWith(fresh);
      node = fresh;
      onChange(next.value);
    };
    /* Both arrows always render; the one with nowhere to go is disabled rather
       than removed. Removing it and reserving the space with a spacer kept the
       geometry symmetric but not the ink — with nothing drawn on the left, the
       visible "Next Gameweek →" sat about 57px right of the pill's centre and
       read as uncentred. A dimmed arrow says "this is the end of the range",
       which is what .gwstep already does. */
    const arrow = (dir, to) => el('button', {
      class: dir,
      title: to ? to.label : '',
      disabled: !to,
      onClick: () => step(dir === 'prev' ? -1 : 1),
    }, to ? to.label : dir);
    return el('div', { class: `hzcycle ${compact ? 'compact' : ''}`, title },
      arrow('prev', opts[i - 1]),
      el('span', { class: 'hzcycle-label' }, opts[i]?.label ?? ''),
      arrow('next', opts[i + 1]),
    );
  };
  node = build(value);
  return node;
}

/** The projection-window cycler: a `cycler` over gameweek counts. */
export function horizonCycler(value, onChange, { options = [1, 3, 5, 8], compact = false } = {}) {
  const label = (n) => (n >= SEASON_HORIZON ? 'Whole season'
    : n === 1 ? 'Next Gameweek' : `Next ${n} GW`);
  return cycler(value, options.map((n) => ({ value: n, label: label(n) })), onChange, { compact });
}
