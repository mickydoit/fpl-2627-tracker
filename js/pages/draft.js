/**
 * Draft board — the view used live on draft night.
 *
 * Three sections over one state: the big board, my turn, and the roster.
 * Ownership comes from data/draft/choices.json when the poller is running, and
 * from hand-marking otherwise; the board cannot tell the difference.
 */
import { $, el, fmt, setKids } from '../ui.js';
import { readSnapshot } from '../data.js';
import { projectAll } from '../model.js';
import { adaptDraftElements, draftPrior } from '../draft/adapt.js';
import { buildBoard, assignTiers, snakePicks } from '../draft/board.js';
import { ownershipFrom, availableRows, myRoster, positionsNeeded, deriveSlot } from '../draft/live.js';
import { recommend } from '../draft/advise.js';

const app = $('#app');
const LEAGUE_SIZE = 6;

const boot = await readSnapshot('draft/bootstrap');
const fixtures = await readSnapshot('fixtures', []);
if (!boot?.elements?.length) {
  setKids(app, el('p', { class: 'empty' }, 'No draft data yet — run `npm run refresh:draft`.'));
  throw new Error('no draft data');
}

let choices = await readSnapshot('draft/choices', { choices: [], element_status: [] });
let manual = new Set(JSON.parse(localStorage.getItem('draftTaken') || '[]'));
let myEntry = +(localStorage.getItem('draftEntry') || 0) || null;
let mySlot = null;
let currentPick = 1;

/* Project every player over the whole season, using the draft prior. */
const adapted = adaptDraftElements(boot);
const { rows: projected } = projectAll(
  { ...boot, elements: adapted }, fixtures, { horizon: 38, prior: draftPrior });

function state() {
  const own = ownershipFrom(choices.element_status);
  for (const id of manual) own.set(id, own.get(id) || -1);
  const pool = availableRows(projected, own);
  const { rows, replacement } = buildBoard(projected, LEAGUE_SIZE);
  const tiered = assignTiers(rows);
  const byId = new Map(tiered.map((r) => [r.id, r]));
  const available = pool.map((r) => byId.get(r.id)).filter(Boolean);
  const roster = myEntry ? myRoster(projected, own, myEntry) : [];
  mySlot = deriveSlot(choices.choices, myEntry) || mySlot;
  currentPick = (choices.choices?.length || manual.size) + 1;
  return { own, available, roster, replacement, tiered };
}

function render() {
  const { available, roster, replacement } = state();
  const myPicks = mySlot ? snakePicks(LEAGUE_SIZE, mySlot) : [];
  const advice = recommend(available, {
    myPicks, currentPick, roster, trials: 300,
  }).slice(0, 12);
  const need = positionsNeeded(roster);
  const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

  const take = (p) => {
    manual.add(p.id);
    localStorage.setItem('draftTaken', JSON.stringify([...manual]));
    render();
  };

  setKids(app,
    el('div', { class: 'tiles' },
      el('div', { class: 'tile accent' },
        el('span', { class: 'k' }, 'Pick'), el('span', { class: 'v' }, `#${currentPick}`),
        el('span', { class: 's' }, mySlot ? `you are slot ${mySlot}` : 'slot not set')),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'On the board'), el('span', { class: 'v' }, `${available.length}`),
        el('span', { class: 's' }, `${roster.length}/15 drafted`)),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'Still needed'),
        el('span', { class: 'v' }, [1, 2, 3, 4].filter((t) => need[t]).map((t) => POS[t]).join(' ')),
        el('span', { class: 's' }, [1, 2, 3, 4].map((t) => `${need[t]}${POS[t][0]}`).join(' '))),
    ),
    el('div', { class: 'card' },
      el('h2', {}, mySlot && myPicks.includes(currentPick) ? 'Your pick — take one of these' : 'Best available'),
      el('div', { class: 'tablewrap' },
        el('table', { class: 'players' },
          el('thead', {}, el('tr', {},
            ...['Player', 'Pos', 'Tier', 'Proj', 'VORP', 'Survives', 'Net', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, advice.map((p) => el('tr', {},
            el('td', {}, p.web_name),
            el('td', {}, POS[p.element_type]),
            el('td', { class: 'num' }, `T${p.tier}`),
            el('td', { class: 'num' }, fmt.pts(p.proj)),
            el('td', { class: 'num' }, fmt.pts(p.vorp)),
            el('td', { class: 'num' }, `${Math.round(p.survivalP * 100)}%`),
            el('td', { class: 'num' }, fmt.pts(p.netValue)),
            el('td', {}, el('button', { class: 'ghost', onClick: () => take(p) }, 'Taken')),
          ))))),
      el('p', { class: 'hint' },
        'Survives = chance he is still there at your next pick. Net = what passing costs you.'),
    ),
    el('div', { class: 'card' },
      el('h2', {}, 'Your squad'),
      roster.length
        ? el('ul', { class: 'mover-list' }, roster.map((p) => el('li', {}, `${POS[p.element_type]} ${p.web_name}`)))
        : el('p', { class: 'empty' }, 'Nothing drafted yet.'),
      el('p', { class: 'hint' }, `Replacement level — ${[1, 2, 3, 4]
        .map((t) => `${POS[t]} ${fmt.pts(replacement[t])}`).join(' · ')}`),
    ),
  );
}

/* Re-read the poller's file while the draft runs. */
setInterval(async () => {
  const fresh = await readSnapshot('draft/choices', null);
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(choices)) {
    choices = fresh;
    render();
  }
}, 4000);

render();
