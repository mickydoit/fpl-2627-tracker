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
