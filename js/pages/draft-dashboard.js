/**
 * Draft → Dashboard.
 *
 * Draft's equivalent of the Classic Squad page, and its home: the eleven, what
 * it rates against the league, who is at risk, and whether the wire has anyone
 * better — one scroll, in that order.
 *
 * Every number is produced by js/pages/dashboard-draft.js. This file chooses a
 * composition; it does not re-derive anything.
 */
import { $, dataBar, addKids } from '../ui.js';
import { matchesSection } from '../matches.js';
import { readSnapshot } from '../data.js';
import { renderDraftDashboard } from './dashboard-draft.js';

const meta = await readSnapshot('meta', null);
if (meta) $('#databar').replaceWith(dataBar(meta));
await renderDraftDashboard($('#app'), { sections: ['head', 'squad', 'review', 'risk', 'waiver', 'notes'] });

/* Fixtures, same as Classic. The Draft board has no ESPN feed of its own — it
   is the same twenty clubs playing the same matches. */
const scoreboard = await readSnapshot('espn-scoreboard', { events: [] });
const matchSec = matchesSection(scoreboard?.events || []);
if (matchSec) addKids($('#app'), matchSec);
