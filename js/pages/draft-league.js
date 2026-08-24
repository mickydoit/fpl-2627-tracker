/**
 * Draft → League.
 *
 * Power rankings, every manager's roster, and the free-agent pool — the view
 * of the league rather than of your own team.
 *
 * This is the League Hub that used to live inside the Draft Night page, shown
 * whenever the draft was finished. Draft Night and the season are different
 * activities, so they are now different pages: the hub renders here, and
 * draft.html stays the pick log it always was.
 *
 * The rosters and pool come back from the Draft view's own data prep rather
 * than being rebuilt here. That is deliberate — the ownership join is the part
 * of this product most likely to go subtly wrong (Draft and classic element
 * ids disagree for 21 of 587 players), so there is exactly one implementation
 * of it and both pages call it.
 */
import { $, setKids, dataBar, el } from '../ui.js';
import { readSnapshot } from '../data.js';
import { renderDraftDashboard } from './dashboard-draft.js';
import { renderHub } from './draft-hub.js';

const meta = await readSnapshot('meta', null);
if (meta) $('#databar').replaceWith(dataBar(meta));

const host = $('#app');
/* Rendering no sections empties the host and hands back the context. If the
   dataset or the league mirror is missing, renderDraftDashboard has already
   written its own explanation into the host and returns nothing — leave it. */
const ctx = await renderDraftDashboard(host, { sections: [] });
if (ctx) {
  const transactions = await readSnapshot('draft/transactions', null);
  setKids(host, renderHub({
    rostersBySlot: ctx.rostersBySlot,
    pool: ctx.pool,
    league: ctx.league,
    transactions,
    teams: ctx.teams,
    mySlot: ctx.mySlot,
    onPlayer: ctx.openPlayer,
    source: 'league',
    onShowDraft: null,
  }));
} else if (!host.childNodes.length) {
  setKids(host, el('p', { class: 'empty' }, 'The Draft league has not been mirrored yet.'));
}
