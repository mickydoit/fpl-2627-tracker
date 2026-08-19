/**
 * The live draft assistant.
 *
 * Manual entry is the authoritative state: there is no league id, no poller and
 * no request per pick. The board dataset is downloaded once, the pick log lives
 * in localStorage, and every number on screen is recomputed in-browser the
 * instant a pick is entered.
 */
import { $, el, fmt, setKids } from '../ui.js';
import { readSnapshot } from '../data.js';
import { projectBoard } from '../draft/project.js';
import {
  createDraft, addPick, undoLastPick, editPick, derive,
  save, load, clear, migrateLegacy, finishDraft, finalPools, encodeDraft, decodeDraft,
} from '../draft/state.js';
import { outstandingDemand, replacementLevel, attachVorp } from '../draft/replacement.js';
import { scarcityByPosition } from '../draft/scarcity.js';
import { evaluate } from '../draft/value.js';
import { LEAGUE_SIZE_DEFAULT, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX, QUOTA } from '../draft/config.js';
import { pull, debouncedPush, syncConfigured, deviceName } from '../draft/sync.js';
import { renderHub } from './draft-hub.js';

const app = $('#app');
const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

migrateLegacy();

const board = await readSnapshot('draft/players');
const fixtures = await readSnapshot('fixtures', []);
// Optional. Present only when FPL_DRAFT_LEAGUE_ID is set on the repo; without
// it the hub shows slot numbers instead of names and nothing else changes.
const league = await readSnapshot('draft/league', null);
if (!board?.players?.length) {
  setKids(app, el('p', { class: 'empty' },
    'Player data has not been published yet. It arrives with the next scheduled refresh.'));
  throw new Error('no board data');
}

// Team short-names come from the players dataset's own `teams` array, not
// from data/bootstrap.json — that file is regenerated as synthetic seed data
// by the test harness and carries fabricated strength ratings that must never
// reach a live draft.
const teams = new Map((board.teams || []).map((t) => [t.id, t.short_name]));

const projected = projectBoard(board.players, fixtures, board.teams || []);
const byId = new Map(projected.map((r) => [r.id, r]));
const typeOf = new Map(projected.map((r) => [r.id, r.element_type]));

/**
 * A draft can arrive in the URL from another device. It never overwrites work
 * silently: if there is already a draft in this browser you are asked, because
 * losing a live pick log is unrecoverable.
 */
function draftFromLink() {
  const raw = new URLSearchParams(location.hash.slice(1)).get('d');
  if (!raw) return null;
  const incoming = decodeDraft(raw);
  history.replaceState(null, '', location.pathname + location.search);
  return incoming;
}

let state = load();
const linked = draftFromLink();
if (linked) {
  const existing = state?.log?.length ?? 0;
  if (!existing || confirm(
    `Load the draft from this link (${linked.log.length} picks)?\n\n`
    + `This browser already has a draft with ${existing} picks, which will be replaced.`)) {
    state = save(linked);
  }
}

/**
 * Adopt the synced board when it is further along than this device's copy.
 *
 * Deliberately conservative: a cloud draft only replaces a local one when it
 * has strictly MORE picks. Equal or fewer means this device is level or ahead,
 * and silently rewinding a live draft would be far worse than a stale mirror.
 * A cloud draft that is behind gets overwritten on the next pick anyway.
 */
async function adoptRemoteIfAhead() {
  if (!syncConfigured()) return;
  const remote = await pull();
  if (!remote?.state?.log) return;
  const here = state?.log?.length ?? 0;
  const there = remote.state.log.length;
  if (there > here) {
    state = save(remote.state);
    render();
    note(`Picked up ${there} picks from your ${remote.device || 'other device'}.`);
  }
}
let query = '';
let posFilter = 0;

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */
function renderSetup() {
  let size = LEAGUE_SIZE_DEFAULT;
  let slot = 1;

  const slotSelect = el('select', { class: 'input' });
  const fillSlots = () => {
    setKids(slotSelect, ...Array.from({ length: size },
      (_, i) => el('option', { value: String(i + 1) }, `Pick ${i + 1} of ${size}`)));
    slotSelect.value = String(Math.min(slot, size));
  };

  const sizeSelect = el('select', {
    class: 'input',
    onChange: (e) => { size = +e.target.value; fillSlots(); },
  }, ...Array.from({ length: LEAGUE_SIZE_MAX - LEAGUE_SIZE_MIN + 1 },
    (_, i) => el('option', { value: String(i + LEAGUE_SIZE_MIN) }, `${i + LEAGUE_SIZE_MIN} managers`)));
  sizeSelect.value = String(LEAGUE_SIZE_DEFAULT);
  fillSlots();

  setKids(app, el('div', { class: 'card setup' },
    el('h2', {}, 'Start a draft'),
    el('p', { class: 'hint' }, 'No league id needed. Everything runs in this browser.'),
    el('label', {}, 'League size', sizeSelect),
    el('label', {}, 'Your draft position', slotSelect),
    el('button', {
      class: 'primary',
      onClick: () => {
        persist(createDraft({ leagueSize: size, mySlot: +slotSelect.value }));
        render();
      },
    }, 'Start draft'),
  ));
}

/* ------------------------------------------------------------------ *
 * the board
 * ------------------------------------------------------------------ */
function compute() {
  const d = derive(state, typeOf);
  const needs = d.needs;
  const available = projected.filter((r) => !d.taken.has(r.id));
  const demand = outstandingDemand(d.rosters, state.leagueSize, typeOf);
  const replacement = replacementLevel(available, demand, { leagueSize: state.leagueSize });
  const withVorp = attachVorp(available, replacement);
  const scarcity = scarcityByPosition(withVorp, demand, { leagueSize: state.leagueSize });
  const ranked = evaluate(withVorp, {
    replacement, demand, scarcity, needs,
    picksRemaining: d.picksRemaining,
    opponentPicksBeforeMyNext: d.opponentPicksBeforeMyNext,
    round: d.round,
    leagueSize: state.leagueSize,
  });
  return { d, needs, available: withVorp, demand, replacement, scarcity, ranked };
}

const pushSoon = debouncedPush();

/** Local save first, cloud mirror second — never the other way round. */
function persist(next) {
  state = save(next);
  pushSoon(state);
  return state;
}

function pick(id, mine) {
  persist(addPick(state, { elementId: id, mine }));
  query = '';
  render();
}

/** A transient status line. Never a modal — nothing may block a pick. */
function note(text) {
  let n = $('#syncnote');
  if (!n) {
    n = el('div', { class: 'syncnote', id: 'syncnote' });
    app.prepend(n);
  }
  n.textContent = text;
  clearTimeout(note._t);
  note._t = setTimeout(() => n.remove(), 4000);
}

function playerLine(r) {
  return `${r.web_name} · ${POS[r.element_type]}${teams.get(r.team) ? ` · ${teams.get(r.team)}` : ''}`;
}

function actionButtons(r) {
  return el('span', { class: 'actions' },
    el('button', { class: 'ghost', onClick: () => pick(r.id, false) }, 'Taken'),
    el('button', { class: 'primary', onClick: () => pick(r.id, true) }, 'Mine'),
  );
}

/**
 * Once the draft is finished the page becomes the League Hub. The draft log is
 * never discarded — `showDraft` flips back to it, and every roster shown in the
 * hub is derived from that log rather than stored separately.
 */
let showDraft = false;

function renderSeason() {
  const d = derive(state, typeOf);
  const rostersBySlot = new Map();
  for (const [slot, ids] of d.rosters) {
    rostersBySlot.set(slot, ids.map((id) => byId.get(id)).filter(Boolean));
  }
  const pool = projected
    .filter((r) => !d.taken.has(r.id))
    .sort((a, b) => b.proj - a.proj);

  setKids(app, renderHub({
    rostersBySlot,
    pool,
    league,
    mySlot: state.mySlot,
    onShowDraft: () => { showDraft = true; render(); },
  }));
}

function render() {
  if (!state) return renderSetup();
  if (state.finished && !showDraft) return renderSeason();
  const { d, needs, available, demand, scarcity, ranked } = compute();
  const best = ranked[0];
  const alternatives = ranked.slice(1, 6);

  const searchBox = el('input', {
    class: 'input search',
    type: 'search',
    placeholder: 'Search a surname, then Taken or Mine',
    value: query,
    onInput: (e) => { query = e.target.value; renderResults(); },
    onKeyDown: (e) => {
      if (e.key === 'Enter' && matches().length) {
        pick(matches()[0].id, e.shiftKey);
      }
    },
  });

  const matches = () => {
    const q = query.trim().toLowerCase();
    let pool = available;
    if (posFilter) pool = pool.filter((r) => r.element_type === posFilter);
    if (q) pool = pool.filter((r) => r.web_name.toLowerCase().includes(q));
    return [...pool].sort((a, b) => b.draftValue - a.draftValue || b.vorp - a.vorp).slice(0, 30);
  };

  const results = el('div', { class: 'results' });
  function renderResults() {
    setKids(results, ...matches().map((r) => el('div', { class: 'result' },
      el('span', { class: 'who' }, playerLine(r)),
      el('span', { class: 'num' }, fmt.pts(r.rosValue)),
      actionButtons(r),
    )));
  }
  renderResults();

  setKids(app,
    /* E — pick status */
    el('div', { class: 'tiles' },
      el('div', { class: 'tile accent' },
        el('span', { class: 'k' }, 'Pick'),
        el('span', { class: 'v' }, `#${d.currentPick}`),
        el('span', { class: 's' }, `Round ${d.round} · slot ${d.onClockSlot} on the clock`)),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, d.picksUntilMyTurn === 0 ? 'You are up' : 'Until your turn'),
        el('span', { class: 'v' }, d.picksUntilMyTurn === null ? '—' : `${d.picksUntilMyTurn}`),
        el('span', { class: 's' }, `you are slot ${state.mySlot} of ${state.leagueSize}`)),
      el('div', { class: 'tile' },
        el('span', { class: 'k' }, 'Squad'),
        el('span', { class: 'v' }, `${d.myRoster.length}/15`),
        el('span', { class: 's' }, [1, 2, 3, 4]
          .map((t) => `${POS[t]} ${QUOTA[t] - needs[t]}/${QUOTA[t]}`).join(' · '))),
    ),

    /* A — your next pick */
    el('div', { class: 'card headline' },
      el('h2', {}, d.picksUntilMyTurn === 0 ? 'Your pick — take this' : 'Best available now'),
      best
        ? el('div', { class: 'pick' },
            el('div', { class: 'pickname' }, playerLine(best)),
            el('div', { class: 'pickstats' },
              el('span', {}, `Draft value ${fmt.pts(best.draftValue)}`),
              el('span', {}, `ROS ${fmt.pts(best.rosValue)}`),
              el('span', {}, `Next 5 ${fmt.pts(best.nearTermValue)}`),
              el('span', {}, `VORP ${fmt.pts(best.vorp)}`),
              el('span', {}, `Survives ${Math.round(best.survival * 100)}%`)),
            el('ul', { class: 'why' }, best.reasons.map((r) => el('li', { class: r.kind }, r.text))),
            actionButtons(best))
        : el('p', { class: 'empty' }, 'Your squad is complete.'),
      alternatives.length
        ? el('div', { class: 'alts' },
            el('h3', {}, 'Alternatives'),
            ...alternatives.map((r) => el('div', { class: 'result' },
              el('span', { class: 'who' }, playerLine(r)),
              el('span', { class: 'num' }, fmt.pts(r.draftValue)),
              actionButtons(r))))
        : null,
    ),

    /* B — search and best available */
    el('div', { class: 'card' },
      el('h2', {}, 'Enter a pick'),
      searchBox,
      el('div', { class: 'posfilter' }, ...[0, 1, 2, 3, 4].map((t) => el('button', {
        class: posFilter === t ? 'pill active' : 'pill',
        onClick: () => { posFilter = t; render(); },
      }, t ? POS[t] : 'All'))),
      results,
      el('p', { class: 'hint' }, 'Enter takes the top match as Taken. Shift+Enter takes it as yours.'),
    ),

    /* D — scarcity */
    el('div', { class: 'card' },
      el('h2', {}, 'Positional scarcity'),
      el('div', { class: 'scarcity' }, ...[1, 2, 3, 4].map((t) => el('div', { class: `srow ${scarcity[t].label.toLowerCase()}` },
        el('span', { class: 'k' }, POS[t]),
        el('span', { class: 'v' }, scarcity[t].label),
        el('span', { class: 's' },
          `${scarcity[t].available} left · ${demand[t]} slots needed · ${scarcity[t].beforeCliff} before the drop`)))),
    ),

    /* C — my squad */
    el('div', { class: 'card' },
      el('h2', {}, 'My squad'),
      d.myRoster.length
        ? el('ul', { class: 'mover-list' }, d.myRoster.map((id) => {
            const r = byId.get(id);
            return el('li', {}, r ? playerLine(r) : `#${id}`);
          }))
        : el('p', { class: 'empty' }, 'Nothing drafted yet.'),
      d.myRoster.length === 15 && !state.finished
        ? el('button', {
            class: 'primary',
            onClick: () => { persist(finishDraft(state)); render(); },
          }, 'Finish draft')
        : null,
      state.finished
        ? el('p', { class: 'hint' },
            `Draft complete. ${finalPools(state, projected.map((r) => r.id), typeOf).undrafted.length} `
            + 'players went undrafted and become your free-agent pool.')
        : null,
      state.finished
        ? el('button', { class: 'primary', onClick: () => { showDraft = false; render(); } }, 'Back to League Hub')
        : null,
    ),

    /* F — the draft log */
    el('div', { class: 'card' },
      el('h2', {}, 'Draft log'),
      el('div', { class: 'logactions' },
        el('button', { class: 'ghost', onClick: () => { persist(undoLastPick(state)); render(); } }, 'Undo last pick'),
        el('button', {
          class: 'ghost',
          onClick: async (e) => {
            const url = `${location.origin}${location.pathname}#d=${encodeDraft(state)}`;
            const btn = e.currentTarget;
            try {
              await navigator.clipboard.writeText(url);
              btn.textContent = 'Link copied — open it on your other device';
            } catch {
              // Clipboard is blocked on insecure origins and some mobile
              // browsers; showing the link is always available as a fallback.
              prompt('Copy this link and open it on your other device:', url);
            }
            setTimeout(() => { btn.textContent = 'Continue on another device'; }, 2500);
          },
        }, 'Continue on another device'),
        el('button', {
          class: 'ghost danger',
          onClick: () => {
            if (confirm('Reset the draft? Everything entered will be lost.')) {
              clear(); state = null; render();
            }
          },
        }, 'Reset draft'),
      ),
      state.log.length
        ? el('div', { class: 'tablewrap' }, el('table', { class: 'players' },
            el('thead', {}, el('tr', {}, ...['#', 'Rd', 'Manager', 'Player', 'Pos', ''].map((h) => el('th', {}, h)))),
            el('tbody', {}, state.log.map((p, i) => {
              const overall = i + 1;
              const r = byId.get(p.elementId);
              return el('tr', { class: p.mine ? 'mine' : '' },
                el('td', {}, `${overall}`),
                el('td', {}, `${Math.floor(i / state.leagueSize) + 1}`),
                el('td', {}, p.mine ? 'You' : `Slot ${slotLabel(overall)}`),
                el('td', {}, r ? r.web_name : `#${p.elementId}`),
                el('td', {}, r ? POS[r.element_type] : '—'),
                el('td', {}, el('button', {
                  class: 'ghost',
                  onClick: () => {
                    const name = prompt('Correct this pick — type a surname:', r ? r.web_name : '');
                    if (!name) return;
                    const found = projected.find((x) => x.web_name.toLowerCase().includes(name.trim().toLowerCase()));
                    if (!found) { alert('No player matched that name.'); return; }
                    persist(editPick(state, i, { elementId: found.id }));
                    render();
                  },
                }, 'Edit')),
              );
            }))))
        : el('p', { class: 'empty' }, 'No picks entered yet.'),
    ),
  );

  // preventScroll: focus must not fight the user's scroll position — a pick
  // made from the headline card should leave the just-updated recommendation
  // in view, not jump the page down to the search box.
  requestAnimationFrame(() => searchBox.focus({ preventScroll: true }));
}

function slotLabel(overall) {
  const round = Math.floor((overall - 1) / state.leagueSize) + 1;
  const idx = overall - (round - 1) * state.leagueSize;
  return String(round % 2 === 1 ? idx : state.leagueSize - idx + 1);
}

render();

// Fire-and-forget: the board is already on screen from localStorage before this
// resolves, so a slow or dead network delays nothing.
adoptRemoteIfAhead();
