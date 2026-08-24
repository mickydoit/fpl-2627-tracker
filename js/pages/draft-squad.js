/**
 * Draft → Squad.
 *
 * The fifteen you own and the eleven you start. In Draft the roster is fixed
 * at the whistle, so the only weekly decision is the lineup — which is why
 * this gets a page rather than a card, and why the horizon picker on it
 * matters more than it does in Classic.
 *
 * The rating rings stay on the page too: "how good is this squad" is the
 * question you are asking while you look at it.
 */
import { $, dataBar } from '../ui.js';
import { readSnapshot } from '../data.js';
import { renderDraftDashboard } from './dashboard-draft.js';

const meta = await readSnapshot('meta', null);
if (meta) $('#databar').replaceWith(dataBar(meta));
await renderDraftDashboard($('#app'), { sections: ['head', 'squad'] });
