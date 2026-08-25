/**
 * Draft → Dashboard.
 *
 * Draft's equivalent of the Classic Squad page, and its home: the eleven, what
 * it rates against the league, who is at risk, and whether the wire has anyone
 * better — one scroll, in that order.
 *
 * Every number is produced by js/pages/dashboard-draft.js. This file chooses a
 * composition; it does not re-derive anything.
 */
import { $, el, dataBar, section, addKids } from '../ui.js';
import { readSnapshot } from '../data.js';
import { renderDraftDashboard } from './dashboard-draft.js';

const meta = await readSnapshot('meta', null);
if (meta) $('#databar').replaceWith(dataBar(meta));
await renderDraftDashboard($('#app'), { sections: ['head', 'squad', 'risk', 'waiver', 'notes'] });

/* Fixtures, same as Classic. The Draft board has no ESPN feed of its own — it
   is the same twenty clubs playing the same matches. */
const scoreboard = await readSnapshot('espn-scoreboard', { events: [] });
const matches = (scoreboard?.events || [])
  .filter((m) => {
    const t = new Date(m.date).getTime();
    return t > Date.now() - 3 * 864e5 && t < Date.now() + 8 * 864e5;
  })
  .sort((a, b) => new Date(a.date) - new Date(b.date))
  .slice(0, 10);
if (matches.length) {
  const sec = section('Matches', { flush: true });
  const wrap = el('div', { class: 'matches' });
  for (const m of matches) {
    addKids(wrap, el('div', { class: `match ${m.state === 'in' ? 'live' : m.state === 'post' ? 'done' : ''}` },
      el('div', { class: 't h' }, m.home.logo ? el('img', { src: m.home.logo, alt: '', loading: 'lazy' }) : null, m.home.short || m.home.name),
      el('div', { class: 'sc' },
        m.state === 'pre'
          ? new Date(m.date).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
          : `${m.home.score ?? 0} – ${m.away.score ?? 0}`,
        el('span', { class: 'st' }, m.state === 'in' ? (m.clock || 'LIVE') : m.state === 'post' ? 'FT' : '')),
      el('div', { class: 't a' }, m.away.logo ? el('img', { src: m.away.logo, alt: '', loading: 'lazy' }) : null, m.away.short || m.away.name)));
  }
  addKids(sec.body, wrap);
  addKids($('#app'), sec.wrap);
}
