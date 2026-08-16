import { loadAll } from '../data.js';
import { $, el, dataBar , setKids, addKids} from '../ui.js';
import { GOAL_PTS, CS_PTS, DEFCON_THRESHOLD } from '../model.js';

const app = $('#app');
const d = await loadAll();
$('#databar').replaceWith(dataBar(d.meta));

const scoring = d.boot?.game_config?.scoring || null;
const chips = d.boot?.chips || [];
const gs = d.boot?.game_settings || {};

const table = (headers, rows) =>
  el('div', { class: 'tablewrap' },
    el('table', { class: 'players', style: 'min-width:0' },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', { class: i === 0 ? 'name' : 'num' }, c))))),
    ),
  );

/* ---------- scoring ---------- */
const g = scoring?.goals_scored || { GKP: GOAL_PTS[1], DEF: GOAL_PTS[2], MID: GOAL_PTS[3], FWD: GOAL_PTS[4] };
const cs = scoring?.clean_sheets || { GKP: CS_PTS[1], DEF: CS_PTS[2], MID: CS_PTS[3], FWD: CS_PTS[4] };
const dc = scoring?.defensive_contribution || { GKP: 0, DEF: 2, MID: 2, FWD: 2 };

setKids(app, 
  el('div', { class: 'card' },
    el('h2', {}, 'Points scoring 2026/27'),
    el('p', { class: 'hint' }, scoring
      ? 'Read live from the FPL API (game_config.scoring), so this stays correct even if the rules change mid-season.'
      : 'Fallback values — run the refresh workflow to read these from the API.'),
    table(['Action', 'GKP', 'DEF', 'MID', 'FWD'], [
      ['Playing 1–59 minutes', 1, 1, 1, 1],
      ['Playing 60+ minutes', 2, 2, 2, 2],
      ['Goal scored', g.GKP, g.DEF, g.MID, g.FWD],
      ['Assist', 3, 3, 3, 3],
      ['Clean sheet', cs.GKP, cs.DEF, cs.MID || 1, '—'],
      ['Defensive contribution', dc.GKP || '—', dc.DEF, dc.MID, dc.FWD],
      ['Every 3 shot saves', 1, '—', '—', '—'],
      ['Penalty saved', scoring?.penalties_saved ?? 5, '—', '—', '—'],
      ['Every 2 goals conceded', -1, -1, '—', '—'],
      ['Penalty missed', -2, -2, -2, -2],
      ['Yellow card', -1, -1, -1, -1],
      ['Red card', -3, -3, -3, -3],
      ['Own goal', -2, -2, -2, -2],
      ['Bonus', '1–3', '1–3', '1–3', '1–3'],
    ]),
  ),

  el('div', { class: 'card' },
    el('h2', {}, 'Defensive contribution'),
    el('p', {}, 'Worth 2 points, capped at 2 per match no matter how far past the threshold you go. Goalkeepers are ineligible.'),
    table(['Position', 'Qualifying actions', 'Threshold'], [
      ['Defenders', 'Clearances, blocks, interceptions, tackles', DEFCON_THRESHOLD[2]],
      ['Midfielders', 'The above plus ball recoveries', DEFCON_THRESHOLD[3]],
      ['Forwards', 'The above plus ball recoveries', DEFCON_THRESHOLD[4]],
    ]),
    el('p', { class: 'hint' }, 'Unchanged for 2026/27 — the widely predicted drop from 12 to 10 for midfielders did not happen. High-volume defensive midfielders remain among the best points-per-million assets in the game.'),
  ),

  el('div', { class: 'card' },
    el('h2', {}, 'Squad and transfers'),
    table(['Rule', 'Value'], [
      ['Budget', `£${((gs.squad_total_spend ?? 1000) / 10).toFixed(1)}m`],
      ['Squad size', gs.squad_squadsize ?? 15],
      ['Starting XI', gs.squad_squadplay ?? 11],
      ['Max per club', gs.squad_team_limit ?? 3],
      ['Squad composition', '2 GKP, 5 DEF, 5 MID, 3 FWD'],
      ['Free transfers per gameweek', 1],
      ['Maximum banked free transfers', (gs.max_extra_free_transfers ?? 4) + 1],
      ['Cost of an extra transfer', '−4 points'],
      ['Transfer cap in one gameweek', gs.transfers_cap ?? 20],
      ['Sell-on fee', `${((gs.transfers_sell_on_fee ?? 0.5) * 100).toFixed(0)}% of profit, rounded down to £0.1m`],
      ['Deadline', '90 minutes before the first kickoff'],
      ['Scores finalised', '09:00 UK time the day after the final match'],
    ]),
  ),

  el('div', { class: 'card' },
    el('h2', {}, 'Chips'),
    chips.length
      ? table(['Chip', 'Available', 'Type'], chips.map((c) => [
          ({ wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' }[c.name] || c.name),
          `GW${c.start_event}–${c.stop_event}`,
          c.chip_type,
        ]))
      : el('p', { class: 'empty' }, 'Run the refresh workflow to read chip windows from the API.'),
    el('p', { class: 'hint' }, 'Two sets of four. First-half chips must be used before the GW19 deadline and do not carry over. Only one chip per gameweek. Bench Boost and Triple Captain can be played in GW1; Wildcard and Free Hit start in GW2. The Assistant Manager chip has been removed for 2026/27.'),
  ),

  el('div', { class: 'card' },
    el('h2', {}, "What changed for 2026/27"),
    el('div', { class: 'notes' }, (d.notes?.rule_changes || []).map((r) =>
      el('div', { class: 'note' },
        el('h3', {}, r.title),
        el('p', {}, r.detail),
        r.impact ? el('p', {}, el('strong', {}, 'Why it matters: '), r.impact) : null,
        r.source ? el('p', { class: 'src' }, el('a', { href: r.source, target: '_blank', rel: 'noopener' }, 'source')) : null,
      ))),
  ),

  el('div', { class: 'card' },
    el('h2', {}, 'How the projections work'),
    el('p', {}, 'Every projection is built from components that map onto the rules above, so you can always see why a player scores well rather than trusting a single number.'),
    el('ul', {},
      el('li', {}, el('strong', {}, 'Appearance — '), 'expected minutes from minutes played per team game, converted into the probability of playing at all and of reaching 60 minutes.'),
      el('li', {}, el('strong', {}, 'Attacking — '), 'expected goals and assists per 90, multiplied by the position-specific goal value, then adjusted for fixture difficulty and home advantage. A confirmed first-choice penalty taker gets a small uplift, because last season’s xG will not reflect newly acquired spot-kick duty.'),
      el('li', {}, el('strong', {}, 'Clean sheet — '), 'the team’s expected goals conceded per match, adjusted for the opponent, run through a Poisson zero probability.'),
      el('li', {}, el('strong', {}, 'Defensive contribution — '), 'the API exposes a per-90 rate of scoring occurrences directly. Where that is missing, the raw action counts are run through a Poisson probability of clearing the 10 or 12 threshold.'),
      el('li', {}, el('strong', {}, 'Bonus — '), 'a logistic map from BPS per 90. Note this is calibrated on the old BPS; the 2026/27 rebalance quietly downgrades stationary centre-backs and upgrades attacking full-backs and shot-stopping keepers, so treat early-season bonus estimates for those profiles with caution.'),
      el('li', {}, el('strong', {}, 'Priors — '), 'players without enough minutes on record are blended toward a price-based prior, so a new signing from abroad is not projected at zero. Those players are flagged in their breakdown.'),
    ),
    el('p', { class: 'hint' }, 'The optimiser then solves for the 15 that maximise the starting XI plus captain plus a discounted bench, within the budget, the 2/5/5/3 quotas and the three-per-club cap.'),
  ),
);
