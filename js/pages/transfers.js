import { loadAll, getState, setState, resolveSquadIds } from '../data.js';
import { projectAll, POS } from '../model.js';
import { suggestTransfers, bestXI, scoreSquad } from '../optimiser.js';
import { $, el, fmt, dataBar, posPill, statusBadge, penBadge, fdrTicker, modal, breakdown , setKids, addKids} from '../ui.js';

const app = $('#app');
const d = await loadAll();
$('#databar').replaceWith(dataBar(d.meta));
if (!d.boot) { setKids(app, el('p', { class: 'empty' }, 'No data yet — run the refresh workflow.')); throw new Error('no data'); }

const state = getState();
let horizon = state.horizon ?? 5;
let riskAversion = state.riskAversion ?? 0.5;
let freeTransfers = state.freeTransfers ?? 1;
let bank = state.bank ?? (d.entry?.entry?.last_deadline_bank ?? 0);

const teams = Object.fromEntries(d.boot.teams.map((t) => [t.id, t]));
let rows = [];
let ctx = null;
let byId = new Map();

function recompute() {
  const r = projectAll(d.boot, d.fixtures, { horizon, riskAversion });
  rows = r.rows;
  ctx = r.ctx;
  byId = new Map(rows.map((p) => [p.id, p]));
}
recompute();

const { ids: squadIds, source } = resolveSquadIds(d.entry, state);

const controls = el('div', { class: 'card' });
const output = el('div', {});
setKids(app, controls, output);

function renderControls() {
  setKids(controls, 
    el('div', { class: 'filters' },
      el('label', {}, 'Horizon',
        el('select', { onchange: (e) => { horizon = +e.target.value; setState({ horizon }); recompute(); run(); } },
          [1, 3, 5, 8, 10].map((n) => el('option', { value: n, selected: n === horizon }, `${n} GW`)))),
      el('label', {}, 'Free transfers',
        el('select', { onchange: (e) => { freeTransfers = +e.target.value; setState({ freeTransfers }); run(); } },
          [0, 1, 2, 3, 4, 5].map((n) => el('option', { value: n, selected: n === freeTransfers }, String(n))))),
      el('label', {}, 'In the bank (£m)',
        el('input', { type: 'number', step: '0.1', min: '0', value: (bank / 10).toFixed(1), style: 'width:6rem',
          oninput: (e) => { bank = Math.round((parseFloat(e.target.value) || 0) * 10); setState({ bank }); } })),
      el('label', {}, 'Risk aversion',
        el('select', { onchange: (e) => { riskAversion = +e.target.value; setState({ riskAversion }); recompute(); run(); } },
          [['0', 'Ignore doubts'], ['0.5', 'Balanced'], ['1', 'Avoid all doubts']].map(([v, l]) =>
            el('option', { value: v, selected: +v === riskAversion }, l)))),
      el('button', { class: 'primary', onClick: run }, 'Find transfers'),
    ),
    el('p', { class: 'hint' },
      source === 'fpl' ? 'Using the squad pulled from your FPL team. '
        : source === 'manual' ? 'Using the squad you saved in the Squad page. '
        : 'No squad found. ',
      'You can bank up to 5 free transfers in 2026/27; extras cost 4 points each.'),
  );
}
renderControls();

function run() {
  if (squadIds.length !== 15) {
    setKids(output, 
      el('div', { class: 'card' },
        el('h2', {}, 'No squad to work from'),
        el('p', {}, 'Set the FPL_ENTRY_ID repository variable so the workflow pulls your real team, or build and save a squad on the Squad page.'),
        el('p', {}, el('a', { href: 'squad.html' }, 'Go to the Squad optimiser →')),
      ),
    );
    return;
  }

  setKids(output, el('p', { class: 'loading' }, 'Evaluating every legal transfer…'));

  setTimeout(() => {
    const res = suggestTransfers(squadIds, rows, {
      bank, freeTransfers, horizon, riskAversion, maxSuggestions: 25,
    });
    if (res.error) {
      setKids(output, el('div', { class: 'banner err' }, res.error));
      return;
    }

    const squad = squadIds.map((id) => byId.get(id)).filter(Boolean);
    const { xi, captain } = bestXI(squad);

    const swapRow = (s) => el('div', { class: 'swap' },
      el('div', { class: 'who out' },
        el('div', { class: 'n' }, s.out.web_name),
        el('div', { class: 'm' }, `${teams[s.out.team]?.short_name} · ${fmt.price(s.out.now_cost)} · ${fmt.pts(s.out.proj)} proj`),
      ),
      el('div', { class: 'arrow' }, '→'),
      el('div', { class: 'who in' },
        el('div', { class: 'n' }, s.in.web_name, ' ', statusBadge(s.in), ' ', penBadge(s.in)),
        el('div', { class: 'm' }, `${teams[s.in.team]?.short_name} · ${fmt.price(s.in.now_cost)} · ${fmt.pts(s.in.proj)} proj`),
      ),
      el('div', { class: `net ${s.net >= 0 ? 'pos' : 'neg'}` },
        fmt.signed(s.net),
        el('div', { class: 'm dim', style: 'font-weight:500' }, s.hit ? `after −${s.hit} hit` : 'free'),
      ),
    );

    const best = res.singles[0];

    setKids(output, 
      el('div', { class: 'tiles' },
        el('div', { class: 'tile accent' },
          el('span', { class: 'k' }, 'Best single move'),
          el('span', { class: 'v' }, best ? fmt.signed(best.net) : '—'),
          el('span', { class: 's' }, best ? `${best.out.web_name} → ${best.in.web_name}` : 'no improving move found'),
        ),
        el('div', { class: 'tile' },
          el('span', { class: 'k' }, `Squad projection`),
          el('span', { class: 'v' }, fmt.pts(scoreSquad(squad, { horizon, riskAversion }))),
          el('span', { class: 's' }, `over ${horizon} gameweeks`),
        ),
        el('div', { class: 'tile' },
          el('span', { class: 'k' }, 'Current captain pick'),
          el('span', { class: 'v', style: 'font-size:1.1rem' }, captain?.web_name || '—'),
          el('span', { class: 's' }, captain ? `${fmt.pts(captain.projPerGW)} per GW` : ''),
        ),
        el('div', { class: 'tile' },
          el('span', { class: 'k' }, 'Flagged in squad'),
          el('span', { class: 'v' }, squad.filter((p) => p.status !== 'a').length),
          el('span', { class: 's' }, squad.filter((p) => p.status !== 'a').map((p) => p.web_name).join(', ') || 'all fit'),
        ),
      ),

      el('div', { class: 'card' },
        el('h2', {}, 'Single transfers'),
        el('p', { class: 'hint' }, `Net gain in projected points over the next ${horizon} gameweeks, after any points hit. Only moves you can afford with ${fmt.price(bank)} in the bank and that keep you within 3 players per club.`),
        res.singles.length
          ? el('div', {}, res.singles.map((s) => {
              const node = swapRow(s);
              node.style.cursor = 'pointer';
              node.addEventListener('click', () => showCompare(s));
              return node;
            }))
          : el('p', { class: 'empty' }, 'No legal transfer improves this squad. Hold your transfer.'),
      ),

      res.pairs.length
        ? el('div', { class: 'card' },
            el('h2', {}, 'Two-transfer combinations'),
            el('p', { class: 'hint' }, freeTransfers >= 2 ? 'Both free.' : `Costs a −${Math.max(0, 2 - freeTransfers) * 4} hit.`),
            el('div', {}, res.pairs.map((pair) =>
              el('div', { style: 'border-bottom:1px solid var(--line);padding-bottom:0.4rem;margin-bottom:0.4rem' },
                pair.moves.map((m) => swapRow({ ...m, hit: 0, net: m.gain })),
                el('p', { class: 'row between small', style: 'padding:0 0.75rem' },
                  el('span', { class: 'dim' }, 'Combined net'),
                  el('strong', { class: pair.net >= 0 ? 'up' : 'down' }, fmt.signed(pair.net)),
                ),
              ),
            )),
          )
        : null,

      el('div', { class: 'card' },
        el('h2', {}, 'Your squad'),
        el('div', { class: 'tablewrap' },
          el('table', { class: 'players' },
            el('thead', {}, el('tr', {}, ['Pos', 'Player', 'Price', `Proj ${horizon}GW`, 'Pts/£m', 'Fixtures'].map((h) => el('th', {}, h)))),
            el('tbody', {}, [...squad].sort((a, b) => a.element_type - b.element_type || b.proj - a.proj).map((p) =>
              el('tr', { class: xi.includes(p) ? 'picked' : '' },
                el('td', {}, posPill(p)),
                el('td', { class: 'name' }, p.web_name, el('span', { class: 'club' }, teams[p.team]?.short_name), ' ', statusBadge(p)),
                el('td', { class: 'num' }, fmt.price(p.now_cost)),
                el('td', { class: 'num proj' }, fmt.pts(p.proj)),
                el('td', { class: 'num' }, fmt.pts(p.value)),
                el('td', {}, fdrTicker(p.fixtures, teams, Math.min(horizon, 6), ctx.fromEvent)),
              ))),
          ),
        ),
      ),
    );
  }, 20);
}

function showCompare(s) {
  const side = (p, label) => el('div', {},
    el('h3', {}, label, ' — ', p.web_name),
    el('p', { class: 'row small' }, posPill(p), el('span', { class: 'dim' }, teams[p.team]?.name), statusBadge(p), penBadge(p)),
    el('p', { class: 'small' }, `${fmt.price(p.now_cost)} · ${fmt.pts(p.proj)} projected · ${p.selected_by_percent}% owned`),
    fdrTicker(p.fixtures, teams, Math.min(horizon, 6), ctx.fromEvent),
    breakdown(p.parts || {}),
  );
  modal(`${s.out.web_name} → ${s.in.web_name}`, el('div', {},
    el('p', { class: 'row' },
      el('strong', { class: s.net >= 0 ? 'up' : 'down' }, `${fmt.signed(s.net)} points over ${horizon} GWs`),
      el('span', { class: 'dim small' }, s.hit ? `includes a −${s.hit} hit` : 'free transfer'),
      el('span', { class: 'dim small' }, `${s.spend >= 0 ? 'costs' : 'frees'} ${fmt.price(Math.abs(s.spend))}, leaving ${fmt.price(s.bankAfter)}`),
    ),
    side(s.out, 'Out'),
    el('hr'),
    side(s.in, 'In'),
  ));
}

run();
