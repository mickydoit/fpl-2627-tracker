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
export function shirt(p, { teams, captain, vice, value, sub, onPlayer, variant = 'classic' }) {
  const isCap = captain && p.id === captain.id;
  const isVice = vice && p.id === vice.id;
  const team = teams[p.team];
  const flagged = p.status && p.status !== 'a';
  /* Keepers wear a different kit and it is the fastest way to read a formation
     at a glance, which is the whole point of showing kits rather than names. */
  const kit = team?.short_name
    ? `img/kits/shirt_${team.short_name}${p.element_type === 1 ? '_1' : ''}.png`
    : null;

  return el('div', {
    class: `shirt ${isCap ? 'cap' : ''} ${flagged ? 'flagged' : ''}`,
    'data-pid': String(p.id),
    'data-pos': POS[p.element_type],
    title: `${p.first_name || ''} ${p.second_name || p.web_name}`.trim() + ` — ${team?.name || ''}`,
    // A drag ends with a click; without this guard, releasing a shirt also
    // opens the player card.
    onClick: onPlayer ? (e) => { if (!e.currentTarget.classList.contains('was-dragged')) onPlayer(p); } : null,
  },
    el('span', { class: 'kit' },
      kit ? el('img', { src: kit, alt: '', loading: 'lazy', width: '44', height: '44' })
        : el('span', { class: 'kit-fallback' }, team?.short_name || '?'),
      /* Captaincy is a Classic mechanic. Draft has no captain, so the variant
         decides whether the badge can appear at all rather than relying on the
         caller remembering not to pass one. */
      variant === 'classic' && isCap ? el('span', { class: 'arm' }, 'C') : null,
      variant === 'classic' && isVice ? el('span', { class: 'arm vice' }, 'V') : null,
      flagged ? el('span', { class: 'shirt-flag', title: p.news || 'Doubtful' }, '!') : null,
    ),
    el('span', { class: 'nm' }, p.web_name),
    /* One box, or two side by side.
     *
     * `value` may return a plain value — one box — or {left, right, hit}, which
     * draws the pair the design uses to compare what a player was projected to
     * score against what he actually scored. `hit` colours the right box only:
     * the projection is not a claim that can be right or wrong on its own, it
     * is the thing the result is measured against. */
    (() => {
      const v = value(p);
      if (v && typeof v === 'object' && 'left' in v) {
        return el('span', { class: 'ptpair' },
          el('span', { class: 'pt half' }, v.left),
          el('span', { class: `pt half ${v.hit || ''}` }, v.right));
      }
      return el('span', { class: 'pt' }, v);
    })(),
    sub ? el('span', { class: 'pr' }, sub(p)) : null,
  );
}

/**
 * A squad on a pitch.
 *
 * Laid out by line rather than as a grid of cards: a formation is information —
 * 3-4-3 and 4-4-2 are different decisions — and it is unreadable when every
 * player is an identical rectangle. Kits carry the club, the keeper kit marks
 * the goalkeeper, and the eye reads the shape before it reads any text.
 *
 * The football logic stays entirely with the caller. This function is handed an
 * eleven and a bench and draws them; it never decides who starts, and changing
 * it cannot change a projection.
 *
 * @param {object[]} xi        the eleven, any legal formation
 * @param {object[]} bench     the rest, drawn on a strip beneath
 * @param {'classic'|'draft'} variant  classic shows captaincy, draft does not
 */
export function squadPitch({ xi, bench = [], teams, captain, vice, value, sub, onPlayer, variant = 'classic' }) {
  const opts = { teams, captain, vice, value, sub, onPlayer, variant };
  const row = (pos) => {
    const ps = xi.filter((p) => p.element_type === pos);
    return ps.length ? el('div', { class: `pitch-row line-${pos}` }, ps.map((p) => shirt(p, opts))) : null;
  };
  return el('div', { class: `pitchwrap v-${variant}` },
    el('div', { class: 'pitch' }, [1, 2, 3, 4].map(row).filter(Boolean)),
    bench.length
      ? el('div', { class: 'bench-strip' },
          el('span', { class: 'bench-label' }, 'Bench'),
          el('div', { class: 'bench-row' }, bench.map((p) => shirt(p, opts))))
      : null,
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

/* ------------------------------------------------------------------ *
 * dragging players between the XI and the bench
 * ------------------------------------------------------------------ */
const HOLD_MS = 400;   // touch: how long to hold before the shirt lifts
const MOVE_PX = 5;     // mouse: movement before it counts as a drag
const SCROLL_PX = 10;  // touch: movement that means "scroll", not "hold"

/**
 * Make every shirt inside `root` draggable onto every other shirt.
 *
 * Generic on purpose: it knows nothing about Classic or Draft, only that some
 * pairs may swap and some may not. `legal(a, b)` decides; `onSwap(a, b)` is
 * told what happened and owns the consequences.
 *
 * The gesture rules are the ones that make this usable on a phone. A touch
 * must HOLD before the shirt lifts, because a finger that moves immediately is
 * scrolling the page, not picking a player up. A mouse lifts on movement,
 * since there is no ambiguity. And the drag paints a ghost that follows the
 * pointer — a shirt that stays put while you drag gives no sense of carrying
 * anything.
 *
 * @param {HTMLElement} root container holding `.shirt[data-pid]` nodes
 * @param {(aId:number,bId:number)=>boolean} legal
 * @param {(aId:number,bId:number)=>void} onSwap
 */
export function enableSwapping(root, { legal, onSwap }) {
  const shirtUnder = (x, y) => document.elementsFromPoint(x, y)
    .find((n) => n.classList?.contains('shirt') && n.dataset.pid);
  const clearTargets = () => root.querySelectorAll('.drop-ok, .drop-hot')
    .forEach((n) => n.classList.remove('drop-ok', 'drop-hot'));
  const markTargets = (id) => {
    for (const n of root.querySelectorAll('.shirt[data-pid]')) {
      const other = Number(n.dataset.pid);
      if (other !== id && legal(id, other)) n.classList.add('drop-ok');
    }
  };

  for (const node of root.querySelectorAll('.shirt[data-pid]')) {
    const id = Number(node.dataset.pid);
    node.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button > 0) return;
      const touch = ev.pointerType === 'touch';
      const x0 = ev.clientX;
      const y0 = ev.clientY;
      let dragging = false;
      let hold = null;
      let lastTarget = null;
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
        ghost._ox = x0 - r.left;
        ghost._oy = y0 - r.top;
        document.body.appendChild(ghost);
        placeGhost(x0, y0);
        markTargets(id);
      };
      if (touch) hold = setTimeout(start, HOLD_MS);

      // Non-passive, and added per drag: a normal swipe beginning on a shirt
      // must still scroll the page.
      const blockScroll = (e) => { if (dragging) e.preventDefault(); };
      document.addEventListener('touchmove', blockScroll, { passive: false });

      const move = (e) => {
        const dx = Math.abs(e.clientX - x0);
        const dy = Math.abs(e.clientY - y0);
        if (!dragging) {
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
          // Suppress the click that follows a drag, or releasing a shirt also
          // opens the player card.
          node.classList.add('was-dragged');
          setTimeout(() => node.classList.remove('was-dragged'), 0);
        }
        const other = t?.dataset.pid ? Number(t.dataset.pid) : null;
        if (other && other !== id && legal(id, other)) onSwap(id, other);
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

      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', cancel);
    });
  }
}

/** A Draft XI is legal at 1 GK, 3+ DEF, 2+ MID, 1+ FWD and eleven players. */
export function legalDraftXI(xi) {
  if (xi.length !== 11) return false;
  const n = (t) => xi.filter((p) => p.element_type === t).length;
  return n(1) === 1 && n(2) >= 3 && n(3) >= 2 && n(4) >= 1;
}


/**
 * A player as a tile: kit, surname, set-piece duty, and up to two facts in
 * boxes beneath.
 *
 * The club name is deliberately absent. It used to sit under the name — "LIV ·
 * £7.0m · 15.0 proj" — and the kit already says it, more legibly than three
 * letters do. What replaces it is the pair of numbers that actually decide a
 * transfer.
 *
 * Draft passes no price, because Draft has no money. The tile shows one box
 * instead of two rather than inventing a value for a mechanic that game does
 * not have.
 *
 * @param {object[]} stats  up to two {label, value, tone} shown under the name
 */
export function playerTile(p, { teams, stats = [], onPlayer = null } = {}) {
  const team = teams?.[p.team];
  const kit = team?.short_name
    ? `img/kits/shirt_${team.short_name}${p.element_type === 1 ? '_1' : ''}.png`
    : null;
  const flagged = p.status && p.status !== 'a';
  return el('div', {
    class: `ptile ${flagged ? 'flagged' : ''}`,
    title: `${p.first_name || ''} ${p.second_name || p.web_name}`.trim() + ` — ${team?.name || ''}`,
    onClick: onPlayer ? () => onPlayer(p) : null,
  },
    el('span', { class: 'kit' },
      kit ? el('img', { src: kit, alt: '', loading: 'lazy', width: '34', height: '34' })
        : el('span', { class: 'kit-fallback' }, team?.short_name || '?'),
      flagged ? el('span', { class: 'shirt-flag', title: p.news || 'Doubtful' }, '!') : null),
    el('span', { class: 'ptile-name' },
      el('b', {}, p.web_name),
      p.penalties_order === 1 ? el('span', { class: 'badge pen' }, 'PEN') : null,
      p.direct_freekicks_order === 1 ? el('span', { class: 'badge fk' }, 'FK') : null),
    stats.length
      ? el('span', { class: 'ptile-stats' }, stats.map((st) =>
          el('span', { class: `ptile-stat ${st.tone || ''}`, title: st.label },
            st.value)))
      : null,
  );
}
