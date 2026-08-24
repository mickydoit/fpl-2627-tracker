/**
 * Draft → Players.
 *
 * The board, ranked the way Draft values players rather than the way Classic
 * does. Two differences drive everything on this page:
 *
 * - **There is no money.** A player is not "good value"; he is worth what he
 *   gives you above the best alternative still available at his position,
 *   which is VORP. Price columns would be meaningless and are absent.
 * - **Ownership is unique.** A player already on a roster is not a target, so
 *   the table names who holds him rather than what percentage of the world does.
 *
 * Replacement level is measured against the free-agent wire, matching
 * `squadVorp` in js/draft/rating.js exactly — see the note on `bestFree` below
 * for why the draft-night version of this number does not survive the draft.
 */
import { $, el, fmt, setKids, dataBar, sortableTable, statusBadge, posPill } from '../ui.js';
import { readSnapshot } from '../data.js';
import { projectBoard } from '../draft/project.js';
import { playerCard } from '../squadview.js';

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const app = $('#app');

const [board, fixtures, league, meta] = await Promise.all([
  readSnapshot('draft/players'),
  readSnapshot('fixtures', []),
  readSnapshot('draft/league', null),
  readSnapshot('meta', null),
]);
if (meta) $('#databar').replaceWith(dataBar(meta));

if (!board?.players?.length) {
  setKids(app, el('p', { class: 'empty' }, 'The Draft board dataset has not been published yet.'));
} else {
  const teams = Object.fromEntries((board.teams || []).map((t) => [t.id, t]));
  const rows = projectBoard(board.players, fixtures, board.teams || []);

  /* Who owns whom, keyed in the BOARD's id space — the Draft game's. Draft and
     classic disagree on ids for 21 of 587 players, and translating here once
     put owned players into the free-agent pool. See CLAUDE.md. */
  const ownerOf = new Map();
  const managerName = new Map((league?.managers || []).map((m) =>
    [m.entryId, m.teamName || m.manager || (m.slot ? `Slot ${m.slot}` : '—')]));
  for (const [elementId, entryId] of Object.entries(league?.ownership || {})) {
    ownerOf.set(Number(elementId), managerName.get(entryId) || '—');
  }

  /**
   * Replacement level, measured against the WIRE rather than against the draft.
   *
   * js/draft/replacement.js answers a draft-night question — how deep the pool
   * has to go to fill everyone's outstanding slots — and once the draft is done
   * every slot is filled, `outstandingDemand` is zero at every position, and the
   * replacement index collapses to the best player on the board. That made this
   * page report VORP 0.0 for all 587 players, which is not a small error: it is
   * the whole column.
   *
   * In season the genuine alternative is the best player you could actually
   * pick up, which is the strongest FREE AGENT at that position — the same
   * definition js/draft/rating.js uses for squadVorp, kept identical here on
   * purpose so the number on this page and the number on the Squad page mean
   * the same thing.
   */
  const bestFree = {};
  for (const r of rows) {
    if (ownerOf.has(r.id)) continue;
    if (!bestFree[r.element_type] || r.proj > bestFree[r.element_type].proj) bestFree[r.element_type] = r;
  }
  const withVorp = rows.map((r) => ({ ...r, vorp: r.proj - (bestFree[r.element_type]?.proj ?? 0) }));
  const freeCount = {};
  for (const r of rows) if (!ownerOf.has(r.id)) freeCount[r.element_type] = (freeCount[r.element_type] || 0) + 1;

  const nextEvent = Math.min(...(fixtures || []).filter((f) => !f.finished && f.event).map((f) => f.event), 1);
  const fixturesFor = (q) => (fixtures || [])
    .filter((f) => f.team_h === q.team || f.team_a === q.team)
    .map((f) => ({
      event: f.event,
      home: f.team_h === q.team,
      opponent: f.team_h === q.team ? f.team_a : f.team_h,
      difficulty: f.team_h === q.team ? f.team_h_difficulty : f.team_a_difficulty,
    }))
    .filter((f) => f.event)
    .sort((a, b) => a.event - b.event);
  const openPlayer = (p) => playerCard(p, { teams, fixturesFor, horizon: 5, fromEvent: nextEvent });

  let onlyFree = false;
  let pos = 0;
  const visible = () => withVorp
    .filter((r) => !onlyFree || !ownerOf.has(r.id))
    .filter((r) => !pos || r.element_type === pos);

  /* Built once and refreshed on filter change: sortableTable owns its sort
     state, and rebuilding it would silently reset the reader's chosen column. */
  const tbl = sortableTable({
    columns: [
      { key: 'pos', label: 'Pos', render: (r) => posPill(r), sortValue: (r) => r.element_type },
      { key: 'web_name', label: 'Player', cls: 'name',
        render: (r) => el('span', {}, r.web_name,
          el('span', { class: 'club' }, teams[r.team]?.short_name || ''), ' ', statusBadge(r)),
        value: (r) => r.web_name },
      { key: 'vorp', label: 'VORP', cls: 'num',
        title: 'Points above the best player still available at this position',
        render: (r) => fmt.pts(r.vorp), value: (r) => r.vorp },
      { key: 'proj', label: 'Rest of season', cls: 'num',
        render: (r) => fmt.pts(r.proj), value: (r) => r.proj },
      { key: 'nearTermValue', label: 'Next 5', cls: 'num',
        render: (r) => fmt.pts(r.nearTermValue ?? 0), value: (r) => r.nearTermValue ?? 0 },
      { key: 'owner', label: 'Owner',
        render: (r) => ownerOf.get(r.id) || el('span', { class: 'dim' }, 'free agent'),
        value: (r) => ownerOf.get(r.id) || '' },
    ],
    rows: visible(),
    initialSort: { key: 'vorp', asc: false },
    onRowClick: openPlayer,
  });

  setKids(app,
    el('div', { class: 'card' },
      el('h2', {}, 'What the wire offers'),
      el('p', { class: 'hint' },
        'The best free agent at each position, and how many there are. This is the bar every '
        + 'player you own is measured against — VORP below is points above this line.'),
      el('div', { class: 'tiles' }, [1, 2, 3, 4].map((t) => el('div', { class: 'tile' },
        el('span', { class: 'k' }, POS[t]),
        el('span', { class: 'v' }, bestFree[t] ? bestFree[t].web_name : '—'),
        el('span', { class: 's' }, bestFree[t]
          ? `${fmt.pts(bestFree[t].proj)} rest of season · ${freeCount[t] || 0} free agents`
          : 'nobody available')))),
    ),
    el('div', { class: 'card' },
      el('div', { class: 'row between' },
        el('h2', {}, 'Board'),
        el('div', { class: 'filters' },
          el('label', {}, 'Position',
            el('select', { onchange: (e) => { pos = +e.target.value; tbl.refresh(visible()); } },
              [[0, 'All'], [1, 'GKP'], [2, 'DEF'], [3, 'MID'], [4, 'FWD']].map(([v, l]) =>
                el('option', { value: String(v) }, l)))),
          el('label', { class: 'check' }, 'Free agents only',
            el('input', { type: 'checkbox', onchange: (e) => { onlyFree = e.target.checked; tbl.refresh(visible()); } })),
        )),
      el('div', { class: 'tablewrap' }, tbl.table),
    ),
  );
}
