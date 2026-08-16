import { loadAll } from '../data.js';
import { $, el, dataBar , setKids, addKids} from '../ui.js';

const app = $('#app');
const d = await loadAll();
$('#databar').replaceWith(dataBar(d.meta));

const n = d.notes;
if (!n) {
  setKids(app, el('p', { class: 'empty' }, 'data/manual/season-notes.json is missing.'));
  throw new Error('no notes');
}

const tabs = ['Managers', 'Signings', 'Departures', 'Set pieces', 'Injuries', 'Rumours', 'News'];
let active = 'Managers';

const tabBar = el('div', { class: 'chiprow', style: 'margin-bottom:1rem' },
  tabs.map((t) => el('button', {
    class: `chip ${t === active ? 'on' : ''}`,
    onClick: (e) => {
      active = t;
      [...tabBar.children].forEach((c) => c.classList.toggle('on', c.textContent === t));
      render();
    },
  }, t)),
);

const body = el('div', {});
setKids(app, 
  el('div', { class: 'card' },
    el('h2', {}, 'Season watchlist'),
    el('ul', {}, (n.watchlist || []).map((w) => el('li', { style: 'margin:0.35rem 0' }, w))),
    el('p', { class: 'hint' }, `Curated ${n.updated}. Window closes 1 September 2026. Edit data/manual/season-notes.json to keep this current — the refresh workflow never touches it.`),
  ),
  tabBar,
  body,
);

const src = (url) => url ? el('p', { class: 'src' }, el('a', { href: url, target: '_blank', rel: 'noopener' }, 'source')) : null;

function render() {
  if (active === 'Managers') {
    setKids(body, el('div', { class: 'notes' }, (n.managers || []).map((m) =>
      el('div', { class: 'note' },
        el('h3', {}, m.club, el('span', { class: 'badge good' }, m.manager), m.system ? el('span', { class: 'badge' }, m.system) : null),
        m.replaced && m.replaced !== '—' ? el('p', { class: 'small dim' }, `Replaced ${m.replaced}`) : null,
        m.style ? el('p', {}, m.style) : null,
        m.fpl_angle ? el('p', {}, el('strong', {}, 'Fantasy angle: '), m.fpl_angle) : null,
        m.beneficiaries?.length ? el('p', { class: 'small' }, el('span', { class: 'dim' }, 'Benefits: '), m.beneficiaries.join(', ')) : null,
        m.avoid?.length ? el('p', { class: 'small' }, el('span', { class: 'dim' }, 'Careful with: '), m.avoid.join(', ')) : null,
        src(m.source),
      ))));
  }

  if (active === 'Signings') {
    const byClub = {};
    for (const t of n.transfers_in || []) (byClub[t.to] ||= []).push(t);
    setKids(body, el('div', { class: 'notes' }, Object.entries(byClub)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([club, list]) =>
        el('div', { class: 'note' },
          el('h3', {}, club, el('span', { class: 'badge' }, `${list.length} in`)),
          el('ul', {}, list.map((t) =>
            el('li', {},
              el('strong', {}, t.player),
              el('span', { class: 'dim' }, ` ${t.pos} · ${t.fee} · from ${t.from}`),
              t.fit ? el('div', { class: 'small' }, t.fit) : null,
            ))),
        ))));
  }

  if (active === 'Departures') {
    setKids(body, el('div', { class: 'notes' }, (n.transfers_out || []).map((t) =>
      el('div', { class: 'note' },
        el('h3', {}, t.player, el('span', { class: 'badge bad' }, `${t.from} → ${t.to}`), el('span', { class: 'badge' }, t.fee)),
        el('p', {}, t.why_it_matters),
      ))));
  }

  if (active === 'Set pieces') {
    const entries = Object.entries(n.penalty_takers || {}).sort((a, b) => a[0].localeCompare(b[0]));
    setKids(body, el('div', { class: 'notes' }, entries.map(([club, v]) =>
      el('div', { class: 'note' },
        el('h3', {}, club),
        el('p', {}, el('strong', {}, 'Penalties: '), (v.pens || []).map((p, i) => el('span', {}, i === 0 ? el('strong', { style: 'color:var(--accent)' }, p) : p, i < v.pens.length - 1 ? ' → ' : '')) ),
        v.corners?.length ? el('p', { class: 'small' }, el('span', { class: 'dim' }, 'Corners: '), v.corners.join(', ')) : null,
        v.note ? el('p', { class: 'small badge warn', style: 'display:block;padding:0.35rem 0.6rem' }, v.note) : null,
      ))));
  }

  if (active === 'Injuries') {
    const order = { season: 0, long: 1, medium: 2, short: 3 };
    const list = [...(n.injuries || [])].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    setKids(body, el('div', { class: 'notes' }, list.map((i) =>
      el('div', { class: 'note' },
        el('h3', {}, i.player,
          el('span', { class: 'badge' }, i.club),
          el('span', { class: `badge ${i.severity === 'season' || i.severity === 'long' ? 'bad' : 'warn'}` }, i.severity),
        ),
        el('p', {}, i.issue, ' — ', el('strong', {}, i.out_until)),
      ))));
  }

  if (active === 'Rumours') {
    setKids(body, el('div', { class: 'notes' }, (n.rumours || []).map((r) =>
      el('div', { class: 'note' },
        el('h3', {}, r.player, el('span', { class: 'badge warn' }, `${r.from} → ${r.to}`)),
        el('p', {}, el('strong', {}, 'Status: '), r.status),
        r.impact ? el('p', {}, r.impact) : null,
      ))));
  }

  if (active === 'News') {
    const news = d.news || [];
    setKids(body, news.length
      ? el('div', { class: 'notes' }, news.map((a) =>
          el('div', { class: 'note' },
            el('h3', {}, a.link ? el('a', { href: a.link, target: '_blank', rel: 'noopener' }, a.headline) : a.headline),
            el('p', { class: 'small dim' }, a.published ? new Date(a.published).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''),
            el('p', {}, a.description || ''),
          )))
      : el('p', { class: 'empty' }, 'No ESPN news in the latest snapshot.'));
  }
}

render();
