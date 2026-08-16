/**
 * Synthetic Draft data so the test suite runs with no network. Mirrors the
 * real bootstrap's shape: season totals, no per-90s, no prices, a draft_rank.
 */
import { writeJSON } from './lib/io.mjs';
import { mkdir } from 'node:fs/promises';

const QUOTA_POOL = { 1: 60, 2: 200, 3: 200, 4: 127 };
const rand = (() => { let s = 20260816; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();

const elements = [];
let id = 1;
for (const [type, count] of Object.entries(QUOTA_POOL)) {
  for (let i = 0; i < count; i++) {
    const quality = Math.max(0.05, 1 - i / count);
    const minutes = Math.round(quality * 3200 * (0.6 + rand() * 0.4));
    const pid = id++;
    elements.push({
      id: pid, element_type: +type, team: (pid % 20) + 1, status: 'a',
      web_name: `D${type}-${i}`, first_name: 'Draft', second_name: `Player ${id}`,
      minutes,
      expected_goals: (quality * (type === 4 ? 18 : type === 3 ? 10 : 2)).toFixed(2),
      expected_assists: (quality * 8).toFixed(2),
      expected_goals_conceded: (minutes / 90 * (1.0 + rand() * 0.8)).toFixed(2),
      saves: type === 1 ? Math.round(quality * 120) : 0,
      defensive_contribution: type === 1 ? 0 : Math.round(quality * minutes / 90 * 9),
      bps: Math.round(quality * 700), yellow_cards: Math.round(rand() * 6),
      total_points: Math.round(quality * 220), points_per_game: (quality * 6).toFixed(1),
      draft_rank: 0, chance_of_playing_next_round: null, news: '',
    });
  }
}
[...elements].sort((a, b) => b.total_points - a.total_points)
  .forEach((p, i) => { p.draft_rank = i + 1; });

const teams = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1, name: `Team ${i + 1}`, short_name: `T${i + 1}`,
  strength_overall_home: 3, strength_overall_away: 3,
}));

await mkdir('data/draft', { recursive: true });
await writeJSON('data/draft/bootstrap.json', { elements, teams, settings: {} });
console.log(`✓ draft seed written — ${elements.length} players`);
