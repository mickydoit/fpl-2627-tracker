/**
 * Draft → Waivers.
 *
 * Who on the wire beats someone you own, and who in your squad is at risk.
 * The two belong together: a waiver claim is only interesting next to the
 * player it would replace.
 *
 * Deliberately NOT Draft Night. Draft Night assigns an unowned pool at the
 * start of the season; waivers trade against a league that already exists,
 * under transaction deadlines Draft Night has no concept of.
 */
import { $, dataBar } from '../ui.js';
import { readSnapshot } from '../data.js';
import { renderDraftDashboard } from './dashboard-draft.js';

const meta = await readSnapshot('meta', null);
if (meta) $('#databar').replaceWith(dataBar(meta));
await renderDraftDashboard($('#app'), { sections: ['risk', 'waiver'] });
