/**
 * Shared squad presentation: the pitch, the rings, the player card.
 *
 * Three pages drew their own version of the pitch and they had drifted — the
 * Squad optimiser showed a player's club, the Dashboard did not, and neither
 * offered his fixtures. One component now serves Classic and Draft alike, so a
 * shirt looks and behaves the same wherever it appears.
 *
 * Nothing here knows which game mode it is rendering. It takes rows and
 * returns elements; Classic passes prices, Draft passes points.
 */
import { el, addKids, fdrTicker, posPill, statusBadge, breakdown, modal } from './ui.js';

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/* ------------------------------------------------------------------ *
 * activity rings
 * ------------------------------------------------------------------ */
/**
 * Concentric progress rings, in the Apple Fitness idiom: a dim track, a bright
 * arc over it, round caps, drawn from twelve o'clock clockwise.
 *
 * Used for the squad rating because that rating is already decomposed — three
 * rings show overall, attack-side and depth at once, which a single number
 * cannot. A ring that would read as empty is still drawn with a minimum sweep,
 * because a zero-length arc with round caps renders as an invisible dot and
 * looks like a bug rather than a low score.
 *
 * @param {{label:string,value:number,max:number,colour:string}[]} rings outermost first
 * @param {{value:string,caption:string}} centre
 */
export function activityRings(rings, centre, { size = 176 } = {}) {
  // Thinner rings than Apple's, because three of them on a 176px disc must
  // still leave a readable hole in the middle for the number.
  const stroke = size * 0.075;
  const gap = stroke * 0.42;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'rings');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', rings.map((r) => `${r.label} ${Math.round((r.value / r.max) * 100)}%`).join(', '));

  rings.forEach((ring, i) => {
    const r = (size / 2) - (stroke / 2) - i * (stroke + gap);
    const circumference = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(1, (ring.value ?? 0) / (ring.max || 1)));
    // Round caps make a true zero invisible; show a sliver so the ring reads
    // as "present but low" rather than "missing".
    const shown = pct === 0 ? 0.004 : pct;

    for (const [cls, colour, dash] of [
      ['ring-track', ring.colour, null],
      ['ring-arc', ring.colour, `${circumference * shown} ${circumference}`],
    ]) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(size / 2));
      c.setAttribute('cy', String(size / 2));
      c.setAttribute('r', String(r));
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', colour);
      c.setAttribute('stroke-width', String(stroke));
      c.setAttribute('stroke-linecap', 'round');
      c.setAttribute('class', cls);
      if (dash) {
        c.setAttribute('stroke-dasharray', dash);
        c.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
      }
      svg.appendChild(c);
    }
  });

  return el('div', { class: 'rings-wrap' },
    el('div', { class: 'rings-disc', style: `width:${size}px;height:${size}px` },
      svg,
      el('div', { class: 'rings-centre' },
        el('span', { class: 'rc-v' }, centre.value),
        centre.caption ? el('span', { class: 'rc-c' }, centre.caption) : null)),
    el('ul', { class: 'rings-key' }, rings.map((r) => el('li', {},
      el('i', { style: `background:${r.colour}` }),
      el('span', { class: 'rk-l' }, r.label),
      el('span', { class: 'rk-v' }, r.detail ?? `${Math.round((r.value / r.max) * 100)}%`)))),
  );
}

/* ------------------------------------------------------------------ *
 * the pitch
 * ------------------------------------------------------------------ */
/**
 * One shirt. Always carries the player's club — the single most common
 * question looking at a squad graphic is "who does he play for", and two of
 * the three old implementations could not answer it.
 */
export function shirt(p, { teams, captain, vice, value, sub, onPlayer }) {
  const isCap = captain && p.id === captain.id;
  const isVice = vice && p.id === vice.id;
  return el('div', {
    class: `shirt ${isCap ? 'cap' : ''} ${p.status && p.status !== 'a' ? 'flagged' : ''}`,
    title: `${p.first_name || ''} ${p.second_name || p.web_name} — ${teams[p.team]?.name || ''}`,
    onClick: onPlayer ? () => onPlayer(p) : null,
  },
    isCap ? el('span', { class: 'arm' }, 'C') : isVice ? el('span', { class: 'arm vice' }, 'V') : null,
    p.status && p.status !== 'a' ? el('span', { class: 'shirt-flag' }, '!') : null,
    el('span', { class: 'nm' }, p.web_name),
    el('span', { class: 'cl' }, teams[p.team]?.short_name || ''),
    el('span', { class: 'pr' }, sub ? sub(p) : ''),
    el('span', { class: 'pt' }, value(p)),
  );
}

/**
 * A full squad laid out by position, with the bench on a strip beneath.
 * Works for any eleven — Classic XI, Draft XI, or an opponent's.
 */
export function squadPitch({ xi, bench = [], teams, captain, vice, value, sub, onPlayer }) {
  const opts = { teams, captain, vice, value, sub, onPlayer };
  const row = (pos) => {
    const ps = xi.filter((p) => p.element_type === pos);
    return ps.length ? el('div', { class: 'pitch-row' }, ps.map((p) => shirt(p, opts))) : null;
  };
  return el('div', { class: 'pitch' },
    [1, 2, 3, 4].map(row).filter(Boolean),
    bench.length ? el('div', { class: 'bench-strip' }, bench.map((p) => shirt(p, opts))) : null,
  );
}

/* ------------------------------------------------------------------ *
 * the player card
 * ------------------------------------------------------------------ */
/**
 * What opens when a shirt is clicked. The fixtures are the point: the old
 * modal showed a projection with no way to see what produced it, and "who does
 * he play next" is the question a squad graphic always raises.
 *
 * @param {object[]} fixtures rows shaped {event, opponent, home, difficulty}
 */
export function playerCard(p, { teams, fixturesFor, horizon = 5, fromEvent = 1, extra = null }) {
  const t = teams[p.team];
  const fx = fixturesFor ? fixturesFor(p) : [];
  const body = el('div', {},
    el('p', { class: 'row' },
      posPill(p),
      el('strong', {}, `${p.first_name || ''} ${p.second_name || p.web_name}`.trim()),
      el('span', { class: 'dim' }, t?.name || ''),
      statusBadge(p)),
    p.news ? el('p', { class: 'small badge warn', style: 'display:block;padding:0.4rem 0.6rem' }, p.news) : null,
    el('h3', {}, `Next ${horizon} fixtures`),
    fx.length
      ? el('div', { class: 'pc-fixtures' }, fdrTicker(fx, teams, horizon, fromEvent))
      : el('p', { class: 'hint' }, 'No fixtures published for this horizon yet.'),
    fx.length ? el('ul', { class: 'pc-fixlist' }, fx.slice(0, horizon).map((f) => {
      const opp = teams[f.opponent];
      return el('li', {},
        el('span', { class: 'pcf-gw' }, `GW${f.event}`),
        el('span', { class: 'pcf-opp' }, `${f.home ? 'vs' : 'at'} ${opp?.short_name || '?'}`),
        el('span', { class: `pcf-d d${f.difficulty}` }, `FDR ${f.difficulty}`));
    })) : null,
    extra,
    p.parts ? el('div', {}, el('h3', {}, 'Per-gameweek breakdown'), breakdown(p.parts)) : null,
    p.parts?.isPrior
      ? el('p', { class: 'hint' }, 'Limited minutes on record — this projection leans on a price-based prior rather than his own data.')
      : null,
  );
  modal(p.web_name, body);
}

export { POS };
