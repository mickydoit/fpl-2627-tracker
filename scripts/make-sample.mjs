/**
 * Generates a SYNTHETIC dataset so the site renders and the model can be tested
 * before the first live fetch. Team names and ids are the real 2026/27 ones;
 * every player stat is invented. meta.source is set to "seed" so the UI shows a
 * gold "seed data" banner rather than pretending this is real.
 *
 * The refresh workflow overwrites all of it on the first run.
 */
import { writeJSON } from './lib/io.mjs';

const TEAMS = [
  ['Arsenal', 'ARS', 5, 5], ['Aston Villa', 'AVL', 4, 4], ['Bournemouth', 'BOU', 4, 3],
  ['Brentford', 'BRE', 3, 3], ['Brighton', 'BHA', 4, 3], ['Chelsea', 'CHE', 4, 4],
  ['Coventry City', 'COV', 2, 2], ['Crystal Palace', 'CRY', 3, 3], ['Everton', 'EVE', 3, 3],
  ['Fulham', 'FUL', 3, 3], ['Hull City', 'HUL', 2, 2], ['Ipswich Town', 'IPS', 2, 2],
  ['Leeds', 'LEE', 3, 2], ['Liverpool', 'LIV', 5, 4], ['Man City', 'MCI', 5, 5],
  ['Man Utd', 'MUN', 4, 4], ['Newcastle', 'NEW', 3, 3], ["Nott'm Forest", 'NFO', 3, 3],
  ['Spurs', 'TOT', 4, 3], ['Sunderland', 'SUN', 3, 2],
];

const teams = TEAMS.map(([name, short, sh, sa], i) => ({
  id: i + 1, code: 100 + i, name, short_name: short,
  strength: Math.round((sh + sa) / 2), strength_overall_home: sh, strength_overall_away: sa,
  strength_attack_home: sh, strength_attack_away: sa,
  strength_defence_home: sh, strength_defence_away: sa,
  played: 0, win: 0, draw: 0, loss: 0, points: 0, position: 0, pulse_id: i + 1,
}));

// Deterministic PRNG so the seed data is stable across runs.
let s = 987654321;
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);

const FIRST = ['James', 'Marcus', 'Luca', 'Diego', 'Tomás', 'Kai', 'Noah', 'Ibrahim', 'Sam', 'Ethan', 'Jonas', 'Rafael', 'Omar', 'Felix', 'Mateo', 'Aaron', 'Callum', 'Dele', 'Youssef', 'Ryan'];
const LAST = ['Hartley', 'Okafor', 'Brennan', 'Vasquez', 'Lindqvist', 'Moreau', 'Ahmed', 'Kovac', 'Whelan', 'Duarte', 'Nakamura', 'Byrne', 'Salgado', 'Weber', 'Traoré', 'Petrov', 'Mensah', 'Ferreira', 'Novak', 'Doyle'];

const COMPOSITION = [
  { type: 1, n: 3, priceRange: [40, 60] },
  { type: 2, n: 8, priceRange: [40, 75] },
  { type: 3, n: 9, priceRange: [45, 130] },
  { type: 4, n: 4, priceRange: [45, 150] },
];

// Keep display names unique — duplicates in fake data make the UI look buggy
// when it is actually fine, and make screenshots hard to read.
const usedNames = new Set();
function uniqueName() {
  for (let attempt = 0; attempt < 400; attempt++) {
    const base = pick(LAST);
    const name = attempt < 40 ? base : `${base}-${pick(FIRST)[0]}${Math.floor(rnd() * 90 + 10)}`;
    if (!usedNames.has(name)) { usedNames.add(name); return name; }
  }
  const fallback = `Player${usedNames.size + 1}`;
  usedNames.add(fallback);
  return fallback;
}

const elements = [];
let id = 1;
for (const t of teams) {
  const quality = (t.strength_overall_home + t.strength_overall_away) / 10; // 0.4 – 1.0
  for (const c of COMPOSITION) {
    for (let i = 0; i < c.n; i++) {
      const isStarter = i < (c.type === 1 ? 1 : c.type === 2 ? 4 : c.type === 3 ? 5 : 2);
      const tier = isStarter ? between(0.55, 1) : between(0.15, 0.6);
      const now_cost = Math.round((c.priceRange[0] + (c.priceRange[1] - c.priceRange[0]) * tier * quality) / 5) * 5;
      const minutes = Math.round(isStarter ? between(1800, 3200) * quality + 400 : between(150, 1400));
      const per90 = minutes / 90;

      const attackRate = c.type === 4 ? between(0.25, 0.85) : c.type === 3 ? between(0.08, 0.62) : c.type === 2 ? between(0.02, 0.18) : 0;
      const xg90 = attackRate * quality * between(0.5, 1.0);
      const xa90 = (c.type === 1 ? 0 : between(0.02, 0.35)) * quality;
      const xgc90 = between(0.9, 2.1) * (1.35 - quality * 0.6);

      const dcActions = c.type === 2 ? between(4, 12) : c.type === 3 ? between(3, 13) : c.type === 4 ? between(1, 6) : 0;
      const dcRate = c.type === 1 ? 0
        : Math.max(0, Math.min(0.95, (dcActions - (c.type === 2 ? 8 : 10)) / 6));

      const status = rnd() < 0.06 ? pick(['d', 'i', 's']) : 'a';
      const goals = Math.round(xg90 * per90 * between(0.8, 1.25));
      const assists = Math.round(xa90 * per90 * between(0.8, 1.25));
      const bps90 = between(10, 20) + xg90 * 22 + dcRate * 9 + (c.type <= 2 ? 6 : 0);

      elements.push({
        id, code: 100000 + id,
        web_name: uniqueName(), first_name: pick(FIRST), second_name: pick(LAST),
        team: t.id, team_code: t.code, element_type: c.type,
        now_cost, status,
        news: status === 'a' ? '' : status === 'i' ? 'Knock - assessed ahead of the weekend' : status === 's' ? 'Suspended' : 'Doubt',
        chance_of_playing_next_round: status === 'd' ? pick([25, 50, 75]) : status === 'a' ? null : 0,
        cost_change_event: rnd() < 0.08 ? (rnd() < 0.5 ? 1 : -1) : 0,
        cost_change_start: 0,
        selected_by_percent: (Math.max(0.1, tier * quality * between(5, 45))).toFixed(1),
        transfers_in_event: Math.round(rnd() * tier * quality * 90000),
        transfers_out_event: Math.round(rnd() * 45000),
        form: (tier * quality * between(1, 7)).toFixed(1),
        ep_next: (tier * quality * between(1.5, 7)).toFixed(1),
        points_per_game: (tier * quality * between(1.5, 6.5)).toFixed(1),
        total_points: Math.round(tier * quality * between(40, 240)),
        event_points: 0,
        minutes, starts: Math.round(minutes / 88),
        goals_scored: goals, assists,
        clean_sheets: Math.round(per90 * Math.exp(-xgc90)),
        goals_conceded: Math.round(xgc90 * per90), own_goals: 0,
        penalties_saved: 0, penalties_missed: 0,
        yellow_cards: Math.round(between(0, 8)), red_cards: 0,
        saves: c.type === 1 ? Math.round(between(2, 4) * per90) : 0,
        bonus: Math.round(bps90 * per90 / 30), bps: Math.round(bps90 * per90),
        influence: '0', creativity: '0', threat: '0', ict_index: '0',
        clearances_blocks_interceptions: Math.round(dcActions * 0.6 * per90),
        recoveries: Math.round(dcActions * 0.5 * per90),
        tackles: Math.round(dcActions * 0.2 * per90),
        defensive_contribution: Math.round(dcRate * per90),
        expected_goals: (xg90 * per90).toFixed(2),
        expected_assists: (xa90 * per90).toFixed(2),
        expected_goal_involvements: ((xg90 + xa90) * per90).toFixed(2),
        expected_goals_conceded: (xgc90 * per90).toFixed(2),
        expected_goals_per_90: +xg90.toFixed(3),
        expected_assists_per_90: +xa90.toFixed(3),
        expected_goal_involvements_per_90: +(xg90 + xa90).toFixed(3),
        expected_goals_conceded_per_90: +xgc90.toFixed(3),
        saves_per_90: c.type === 1 ? +between(2, 4).toFixed(2) : 0,
        goals_conceded_per_90: +xgc90.toFixed(2),
        starts_per_90: 1,
        clean_sheets_per_90: +Math.exp(-xgc90).toFixed(2),
        defensive_contribution_per_90: +dcRate.toFixed(3),
        penalties_order: isStarter && c.type >= 3 && i === 0 && rnd() < 0.5 ? 1 : null,
        corners_and_indirect_freekicks_order: isStarter && rnd() < 0.15 ? 1 : null,
        direct_freekicks_order: null,
        penalties_text: '', corners_and_indirect_freekicks_text: '', direct_freekicks_text: '',
      });
      id++;
    }
  }
}

/* 38 gameweeks, one round-robin double. */
const events = [];
const start = new Date('2026-08-21T17:30:00Z');
for (let gw = 1; gw <= 38; gw++) {
  events.push({
    id: gw, name: `Gameweek ${gw}`,
    deadline_time: new Date(start.getTime() + (gw - 1) * 7 * 864e5).toISOString(),
    finished: false, data_checked: false,
    is_previous: false, is_current: false, is_next: gw === 1,
    average_entry_score: 0, chip_plays: [], most_selected: null, most_captained: null,
  });
}

const fixtures = [];
let fid = 1;
// Circle method: a standard 38-round double round-robin over 20 teams.
const order = teams.map((t) => t.id);
for (let round = 0; round < 19; round++) {
  for (let i = 0; i < 10; i++) {
    const h = order[i];
    const a = order[19 - i];
    const home = round % 2 === 0 ? h : a;
    const away = round % 2 === 0 ? a : h;
    const ht = teams[home - 1];
    const at = teams[away - 1];
    const diff = (opp) => Math.max(1, Math.min(5, Math.round((opp.strength_overall_home + opp.strength_overall_away) / 2)));
    for (const [gw, hh, aa] of [[round + 1, home, away], [round + 20, away, home]]) {
      fixtures.push({
        id: fid++, code: 200000 + fid, event: gw,
        kickoff_time: new Date(start.getTime() + (gw - 1) * 7 * 864e5 + 5400e3).toISOString(),
        team_h: hh, team_a: aa, team_h_score: null, team_a_score: null,
        started: false, finished: false, finished_provisional: false, minutes: 0,
        team_h_difficulty: diff(teams[aa - 1]), team_a_difficulty: diff(teams[hh - 1]),
        stats: [],
      });
    }
  }
  // rotate all but the first
  order.splice(1, 0, order.pop());
}

await writeJSON('data/bootstrap.json', {
  elements, teams, events,
  element_types: [
    { id: 1, singular_name_short: 'GKP', plural_name: 'Goalkeepers', squad_select: 2, squad_min_play: 1, squad_max_play: 1, element_count: elements.filter((e) => e.element_type === 1).length },
    { id: 2, singular_name_short: 'DEF', plural_name: 'Defenders', squad_select: 5, squad_min_play: 3, squad_max_play: 5, element_count: elements.filter((e) => e.element_type === 2).length },
    { id: 3, singular_name_short: 'MID', plural_name: 'Midfielders', squad_select: 5, squad_min_play: 2, squad_max_play: 5, element_count: elements.filter((e) => e.element_type === 3).length },
    { id: 4, singular_name_short: 'FWD', plural_name: 'Forwards', squad_select: 3, squad_min_play: 1, squad_max_play: 3, element_count: elements.filter((e) => e.element_type === 4).length },
  ],
  chips: [
    { id: 1, name: 'wildcard', number: 1, start_event: 2, stop_event: 19, chip_type: 'transfer' },
    { id: 2, name: 'freehit', number: 1, start_event: 2, stop_event: 19, chip_type: 'transfer' },
    { id: 3, name: 'bboost', number: 1, start_event: 1, stop_event: 19, chip_type: 'team' },
    { id: 4, name: '3xc', number: 1, start_event: 1, stop_event: 19, chip_type: 'team' },
    { id: 5, name: 'wildcard', number: 2, start_event: 20, stop_event: 38, chip_type: 'transfer' },
    { id: 6, name: 'freehit', number: 2, start_event: 20, stop_event: 38, chip_type: 'transfer' },
    { id: 7, name: 'bboost', number: 2, start_event: 20, stop_event: 38, chip_type: 'team' },
    { id: 8, name: '3xc', number: 2, start_event: 20, stop_event: 38, chip_type: 'team' },
  ],
  phases: [{ id: 1, name: 'Overall', start_event: 1, stop_event: 38 }],
  game_settings: {
    squad_squadsize: 15, squad_squadplay: 11, squad_team_limit: 3, squad_total_spend: 1000,
    ui_currency_multiplier: 10, transfers_cap: 20, transfers_sell_on_fee: 0.5,
    max_extra_free_transfers: 4, stats_form_days: 30, timezone: 'UTC',
  },
  game_config: {
    scoring: {
      long_play: 2, short_play: 1, saves: 1, assists: 3, bonus: 1,
      penalties_saved: 5, penalties_missed: -2, yellow_cards: -1, red_cards: -3, own_goals: -2,
      goals_scored: { GKP: 10, DEF: 6, MID: 5, FWD: 4 },
      clean_sheets: { GKP: 4, DEF: 4, MID: 1, FWD: 0 },
      goals_conceded: { GKP: -1, DEF: -1, MID: 0, FWD: 0 },
      defensive_contribution: { GKP: 0, DEF: 2, MID: 2, FWD: 2 },
    },
  },
  element_stats: [],
  total_players: 4760674,
});

await writeJSON('data/fixtures.json', fixtures);
await writeJSON('data/meta.json', {
  source: 'seed',
  fetched_at: new Date().toISOString(),
  current_gw: null,
  next_gw: 1,
  next_deadline: events[0].deadline_time,
  player_count: elements.length,
  total_players: 4760674,
  warnings: ['Synthetic seed data. Run the "Refresh FPL data" workflow to replace it with real FPL and ESPN data.'],
});

// Placeholders for everything the live fetch produces. Without these the site
// still works (every loader has a fallback), but each page load fires eight
// requests that 404 — console noise plus wasted round trips on mobile.
await writeJSON('data/live.json', { event: null, elements: [] });
await writeJSON('data/entry.json', null);
await writeJSON('data/leagues.json', []);
await writeJSON('data/espn-scoreboard.json', { calendar: [], events: [] });
await writeJSON('data/espn-standings.json', []);
await writeJSON('data/espn-news.json', []);
await writeJSON('data/set-pieces.json', { last_updated: null, teams: [] });
await writeJSON('data/price-history.json', { updated: null, players: {} });

console.log(`✓ seed data written — ${elements.length} players, ${fixtures.length} fixtures`);
