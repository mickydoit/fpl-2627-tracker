import { loadAll, getState, setState } from '../data.js';
import { projectAll, POS } from '../model.js';
import { $, el, fmt, dataBar, sortableTable, statusBadge, penBadge, posPill, fdrTicker, modal, breakdown , setKids, addKids} from '../ui.js';

const app = $('#app');
const d = await loadAll();
$('#databar').replaceWith(dataBar(d.meta));
if (!d.boot) { setKids(app, el('p', { class: 'empty' }, 'No data yet — run the refresh workflow.')); throw new Error('no data'); }

const state = getState();
let horizon = state.horizon ?? 5;
let filters = { pos: new Set(), team: '', maxPrice: 15.5, q: '', available: true, minMinutes: 0 };

const teams = Object.fromEntries(d.boot.teams.map((t) => [t.id, t]));
let rows = [];
let ctx = null;

function recompute() {
  const r = projectAll(d.boot, d.fixtures, { horizon });
  rows = r.rows;
  ctx = r.ctx;
}
recompute();

/* ---------- controls ---------- */
const search = el('input', { type: 'search', placeholder: 'Name…', oninput: (e) => { filters.q = e.target.value.toLowerCase(); render(); } });
const teamSel = el('select', { onchange: (e) => { filters.team = e.target.value; render(); } },
  el('option', { value: '' }, 'All clubs'),
  [...d.boot.teams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => el('option', { value: t.id }, t.name)),
);
const priceInput = el('input', { type: 'number', step: '0.1', min: '3.5', max: '16', value: '15.5', style: 'width:5.5rem', oninput: (e) => { filters.maxPrice = parseFloat(e.target.value) || 20; render(); } });
const horizonSel = el('select', { onchange: (e) => { horizon = parseInt(e.target.value, 10); setState({ horizon }); recompute(); render(); } },
  [1, 3, 5, 8, 10].map((n) => el('option', { value: n, selected: n === horizon }, `${n} GW`)),
);
const availChk = el('input', { type: 'checkbox', checked: true, onchange: (e) => { filters.available = e.target.checked; render(); } });
const minsInput = el('input', { type: 'number', step: '90', min: '0', value: '0', style: 'width:5.5rem', oninput: (e) => { filters.minMinutes = parseInt(e.target.value, 10) || 0; render(); } });

const posChips = el('div', { class: 'chiprow' },
  [1, 2, 3, 4].map((pos) =>
    el('button', {
      class: 'chip', 'data-pos': pos,
      onClick: (e) => {
        if (filters.pos.has(pos)) filters.pos.delete(pos); else filters.pos.add(pos);
        e.target.classList.toggle('on');
        render();
      },
    }, POS[pos]),
  ),
);

setKids(app, 
  el('div', { class: 'card' },
    el('div', { class: 'filters' },
      el('label', {}, 'Search', search),
      el('label', {}, 'Club', teamSel),
      el('label', {}, 'Max price', priceInput),
      el('label', {}, 'Horizon', horizonSel),
      el('label', {}, 'Min minutes', minsInput),
      el('label', { class: 'row', style: 'flex-direction:row;align-items:center;gap:0.4rem' }, availChk, 'Available only'),
    ),
    posChips,
  ),
);

const tableCard = el('div', { class: 'card' });
addKids(app, tableCard);

/* ---------- columns ---------- */
const columns = [
  { key: 'pos', label: 'Pos', render: (p) => posPill(p), sortValue: (p) => p.element_type, ascDefault: true },
  {
    key: 'web_name', label: 'Player', cls: 'name', ascDefault: true,
    render: (p) => el('span', {},
      p.web_name,
      el('span', { class: 'club' }, teams[p.team]?.short_name),
      ' ', statusBadge(p), ' ', penBadge(p),
    ),
  },
  { key: 'now_cost', label: 'Price', cls: 'num', render: (p) => fmt.price(p.now_cost) },
  { key: 'proj', label: `Proj ${horizon}GW`, cls: 'num', title: 'Projected points over the horizon', render: (p) => el('span', { class: 'proj' }, fmt.pts(p.proj)) },
  { key: 'value', label: 'Pts / £m', cls: 'num', render: (p) => fmt.pts(p.value) },
  { key: 'ep_next', label: 'FPL xP', cls: 'num', title: "FPL's own expected points for the next gameweek", sortValue: (p) => parseFloat(p.ep_next) || 0, render: (p) => p.ep_next },
  { key: 'form', label: 'Form', cls: 'num', sortValue: (p) => parseFloat(p.form) || 0, render: (p) => p.form },
  { key: 'total_points', label: 'Pts', cls: 'num' },
  { key: 'selected_by_percent', label: 'Own %', cls: 'num', sortValue: (p) => parseFloat(p.selected_by_percent) || 0, render: (p) => `${p.selected_by_percent}%` },
  { key: 'xgi90', label: 'xGI/90', cls: 'num', title: 'Expected goal involvements per 90', sortValue: (p) => parseFloat(p.expected_goal_involvements_per_90) || 0, render: (p) => (parseFloat(p.expected_goal_involvements_per_90) || 0).toFixed(2) },
  { key: 'dc90', label: 'DefCon/90', cls: 'num', title: 'Defensive contribution points scored per 90', sortValue: (p) => parseFloat(p.defensive_contribution_per_90) || 0, render: (p) => (parseFloat(p.defensive_contribution_per_90) || 0).toFixed(2) },
  { key: 'minutes', label: 'Mins', cls: 'num' },
  { key: 'fixtures', label: 'Fixtures', sortValue: (p) => p.fixtures.reduce((s, f) => s + f.difficulty, 0) / Math.max(1, p.fixtures.length), ascDefault: true, render: (p) => fdrTicker(p.fixtures, teams, Math.min(horizon, 6), ctx.fromEvent) },
];

let tbl = null;

function filtered() {
  return rows.filter((p) => {
    if (filters.pos.size && !filters.pos.has(p.element_type)) return false;
    if (filters.team && String(p.team) !== filters.team) return false;
    if (p.now_cost / 10 > filters.maxPrice) return false;
    if (filters.available && (p.status === 'i' || p.status === 's' || p.status === 'u' || p.status === 'n')) return false;
    if (p.minutes < filters.minMinutes) return false;
    if (filters.q) {
      const hay = `${p.first_name} ${p.second_name} ${p.web_name}`.toLowerCase();
      if (!hay.includes(filters.q)) return false;
    }
    return true;
  });
}

function render() {
  const data = filtered();
  columns[3].label = `Proj ${horizon}GW`;
  if (!tbl) {
    tbl = sortableTable({ columns, rows: data, initialSort: { key: 'proj', asc: false }, onRowClick: showPlayer });
    setKids(tableCard, 
      el('p', { class: 'hint', id: 'count' }, ''),
      el('div', { class: 'tablewrap' }, tbl.table),
    );
  } else {
    tbl.refresh(data);
  }
  $('#count').textContent = `${data.length} players · showing the top 400 · click a row for the projection breakdown`;
}
render();

function showPlayer(p) {
  const t = teams[p.team];
  const stat = (k, v) => el('div', { class: 'tile' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));
  modal(p.web_name, el('div', {},
    el('p', { class: 'row' }, posPill(p), el('strong', {}, `${p.first_name} ${p.second_name}`), el('span', { class: 'dim' }, t?.name), statusBadge(p), penBadge(p)),
    p.news ? el('p', { class: 'badge warn', style: 'display:block;padding:0.4rem 0.6rem' }, p.news) : null,
    el('div', { class: 'tiles' },
      stat('Price', fmt.price(p.now_cost)),
      stat(`Proj ${horizon}GW`, fmt.pts(p.proj)),
      stat('Pts / £m', fmt.pts(p.value)),
      stat('Owned', `${p.selected_by_percent}%`),
    ),
    el('h3', {}, 'Projection per gameweek'),
    breakdown(p.parts || {}),
    p.parts?.isPrior ? el('p', { class: 'hint' }, `Only ${p.minutes} minutes on record — this leans on a price-based prior rather than his own numbers.`) : null,
    el('h3', {}, 'Fixtures'),
    fdrTicker(p.fixtures, teams, Math.min(horizon, 8), ctx.fromEvent),
    el('h3', {}, 'Underlying'),
    el('ul', { class: 'mover-list' },
      el('li', {}, el('span', {}, 'xG per 90'), el('strong', {}, (parseFloat(p.expected_goals_per_90) || 0).toFixed(2))),
      el('li', {}, el('span', {}, 'xA per 90'), el('strong', {}, (parseFloat(p.expected_assists_per_90) || 0).toFixed(2))),
      el('li', {}, el('span', {}, 'xGC per 90'), el('strong', {}, (parseFloat(p.expected_goals_conceded_per_90) || 0).toFixed(2))),
      el('li', {}, el('span', {}, 'DefCon per 90'), el('strong', {}, (parseFloat(p.defensive_contribution_per_90) || 0).toFixed(2))),
      el('li', {}, el('span', {}, 'BPS per 90'), el('strong', {}, p.minutes ? ((p.bps / p.minutes) * 90).toFixed(1) : '—')),
      el('li', {}, el('span', {}, 'Starts'), el('strong', {}, p.starts)),
      el('li', {}, el('span', {}, 'Set pieces'), el('strong', {}, [p.penalties_order === 1 && 'penalties', p.corners_and_indirect_freekicks_order === 1 && 'corners', p.direct_freekicks_order === 1 && 'free-kicks'].filter(Boolean).join(', ') || '—')),
    ),
  ));
}
