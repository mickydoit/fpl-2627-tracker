/**
 * Draft → Dashboard.
 *
 * The overview: where the squad sits in the league, what it rates over the
 * chosen window, and whether the wire has anyone better. The squad pitch and
 * the risk breakdown moved to their own pages when Draft became a product in
 * its own right, so this page asks for those two sections only.
 *
 * Every number here is still produced by js/pages/dashboard-draft.js — this
 * file chooses a composition, it does not re-derive anything.
 */
import { $, dataBar } from '../ui.js';
import { readSnapshot } from '../data.js';
import { renderDraftDashboard } from './dashboard-draft.js';

const meta = await readSnapshot('meta', null);
if (meta) $('#databar').replaceWith(dataBar(meta));
await renderDraftDashboard($('#app'), { sections: ['head', 'waiver'] });
