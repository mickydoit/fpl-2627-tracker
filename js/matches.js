/**
 * The fixture list, in two views.
 *
 * Was two near-identical copies — one in each dashboard — rendering a flat run
 * of ten matches with the date nowhere on the page. A row reading "BRE 3-0 TOT"
 * with no day against it is a result you cannot place, and a row reading
 * "CRY Sat 05:00 MNC" does not say WHICH Saturday. So matches are grouped under
 * the day they are played, and the section carries a control for looking
 * forward as well as back.
 *
 * Times come from ESPN's `date`, which is UTC (the payload's Z suffix).
 *
 * They are grouped and shown in UK time, not the reader's. A Premier League
 * fixture is a "Saturday 3pm" wherever you watch it, the rest of this site
 * already quotes UK deadlines and price changes, and grouping by local date
 * moved a Saturday evening kickoff onto Sunday for anyone east of Europe —
 * this machine is on Australia/Brisbane, where a 15:00 kickoff rendered as
 * 00:00 the next day. Where the reader's own zone differs, the local time is
 * shown underneath, since that is the one that answers "when can I watch".
 */
import { el, setKids, section, cycler } from './ui.js';

export const MATCH_VIEWS = [
  { value: 'results', label: 'Latest results' },
  { value: 'upcoming', label: 'Upcoming fixtures' },
];

/** Played, or playing right now. `pre` is the only state that has not started. */
const isPlayed = (m) => m.state === 'post' || m.state === 'in';

const UK = 'Europe/London';
const localZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return UK; }
})();
const showLocal = localZone !== UK;

const dayKey = (d) => d.toLocaleDateString('en-GB', { timeZone: UK, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = (d) => {
  const today = new Date();
  const k = dayKey(d);
  if (k === dayKey(today)) return 'Today';
  const tom = new Date(today.getTime() + 864e5);
  if (k === dayKey(tom)) return 'Tomorrow';
  const yst = new Date(today.getTime() - 864e5);
  if (k === dayKey(yst)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { timeZone: UK, weekday: 'long', day: 'numeric', month: 'long' });
};
const kickoff = (d) => d.toLocaleTimeString('en-GB', { timeZone: UK, hour: '2-digit', minute: '2-digit' });
/* Same instant in the reader's zone, with the weekday when it lands on a
   different day from the UK one — "21:30" alone would be a lie on a Sunday. */
const localKickoff = (d) => {
  const sameDay = d.toLocaleDateString('en-GB', { timeZone: UK })
    === d.toLocaleDateString('en-GB', { timeZone: localZone });
  return d.toLocaleTimeString('en-GB', { timeZone: localZone, hour: '2-digit', minute: '2-digit' })
    + (sameDay ? '' : ` ${d.toLocaleDateString('en-GB', { timeZone: localZone, weekday: 'short' })}`);
};

function matchRow(m) {
  const d = new Date(m.date);
  const played = isPlayed(m);
  const badge = (side) => (side.logo
    ? el('img', { src: side.logo, alt: '', loading: 'lazy' })
    : null);
  return el('div', { class: `match ${m.state === 'in' ? 'live' : m.state === 'post' ? 'done' : ''}` },
    el('div', { class: 't h' }, badge(m.home), el('span', {}, m.home.short || m.home.name)),
    el('div', { class: 'sc' },
      played ? `${m.home.score ?? 0} – ${m.away.score ?? 0}` : kickoff(d),
      el('span', { class: 'st' },
        m.state === 'in' ? (m.clock || 'LIVE')
          : m.state === 'post' ? 'FT'
            : showLocal ? `${localKickoff(d)} your time` : 'KO')),
    el('div', { class: 't a' }, el('span', {}, m.away.short || m.away.name), badge(m.away)));
}

/**
 * @param {object[]} events ESPN scoreboard events
 * @param {'results'|'upcoming'} view
 */
/**
 * The schedule for one view, grouped into UK matchdays. Pure — no DOM — so the
 * ordering and the grouping can be checked without a browser.
 *
 * @returns {{key: string, date: Date, items: object[]}[]}
 */
export function groupByDay(events, view) {
  const rows = (events || [])
    .filter((m) => (view === 'upcoming' ? !isPlayed(m) : isPlayed(m)))
    /* Results read newest-first — the last thing played is the thing you want.
       Fixtures read soonest-first, for the same reason. */
    .sort((a, b) => (view === 'upcoming'
      ? new Date(a.date) - new Date(b.date)
      : new Date(b.date) - new Date(a.date)));

  const days = [];
  for (const m of rows) {
    const d = new Date(m.date);
    const k = dayKey(d);
    const last = days[days.length - 1];
    if (last && last.key === k) last.items.push(m);
    else days.push({ key: k, date: d, items: [m] });
  }
  return days;
}

export function matchList(events, view) {
  const days = groupByDay(events, view);
  if (!days.length) {
    return el('p', { class: 'empty tight' },
      view === 'upcoming' ? 'No fixtures scheduled yet.' : 'Nothing has been played yet.');
  }

  return el('div', { class: 'matches' }, days.map((day) =>
    el('div', { class: 'matchday' },
      el('div', { class: 'mdhead' }, dayLabel(day.date)),
      day.items.map(matchRow))));
}

/**
 * The whole section, control included. Both dashboards call this — they were
 * rendering the same twenty clubs playing the same matches from two copies of
 * the same twenty lines.
 */
export function matchesSection(events, { initial = 'results' } = {}) {
  if (!events?.length) return null;
  let view = initial;
  const sec = section('Matches', {
    flush: true,
    hint: `Results and fixtures from ESPN, in UK time${showLocal ? ` — your zone is ${localZone}` : ''}`,
  });
  const paint = () => setKids(sec.body, matchList(events, view));
  setKids(sec.ctl, cycler(view, MATCH_VIEWS, (v) => { view = v; paint(); }));
  paint();
  return sec.wrap;
}
