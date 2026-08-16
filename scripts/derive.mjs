/**
 * Runs the projection model server-side after every fetch and writes
 * data/insights.json — precomputed shortlists plus a squad suggestion.
 *
 * This is not required by the site (the browser runs the same model on the same
 * data), but it means the workflow fails loudly if the model breaks, and it gives
 * you something readable to diff in the commit.
 */
import { readJSON, writeJSON } from './lib/io.mjs';
import { projectAll, POS } from '../js/model.js';
import { optimiseSquad, validate } from '../js/optimiser.js';

const boot = await readJSON('data/bootstrap.json');
const fixtures = await readJSON('data/fixtures.json', []);

if (!boot?.elements?.length) {
  console.error('No bootstrap data — run scripts/fetch-all.mjs first.');
  process.exit(1);
}

const HORIZON = 5;
const { rows, ctx } = projectAll(boot, fixtures, { horizon: HORIZON, riskAversion: 0.5 });
const teams = Object.fromEntries(boot.teams.map((t) => [t.id, t.short_name]));

const slim = (p) => ({
  id: p.id, name: p.web_name, team: teams[p.team], pos: POS[p.element_type],
  price: p.price, proj: +p.proj.toFixed(2), value: +p.value.toFixed(2),
  owned: parseFloat(p.selected_by_percent), status: p.status,
  isPrior: !!p.parts?.isPrior,
});

const available = rows.filter((p) => p.status === 'a' && p.proj > 0);

const insights = {
  generated_at: new Date().toISOString(),
  horizon: HORIZON,
  from_gameweek: ctx.fromEvent,
  games_of_evidence: ctx.games,
  top_projected: [...available].sort((a, b) => b.proj - a.proj).slice(0, 30).map(slim),
  best_value: [...available].sort((a, b) => b.value - a.value).slice(0, 30).map(slim),
  differentials: [...available]
    .filter((p) => parseFloat(p.selected_by_percent) < 8 && p.proj > 0)
    .sort((a, b) => b.proj - a.proj).slice(0, 25).map(slim),
  by_position: Object.fromEntries([1, 2, 3, 4].map((pos) => [
    POS[pos],
    [...available].filter((p) => p.element_type === pos).sort((a, b) => b.proj - a.proj).slice(0, 15).map(slim),
  ])),
  flagged: rows.filter((p) => p.status !== 'a' && parseFloat(p.selected_by_percent) > 3)
    .map((p) => ({ ...slim(p), news: p.news })),
};

// A squad suggestion computed the same way the Squad page does it.
const opt = optimiseSquad(rows, { horizon: HORIZON, riskAversion: 0.5, restarts: 10 });
if (opt) {
  const check = validate(opt.squad);
  if (!check.ok) {
    console.error('Optimiser produced an illegal squad:', check.errors);
    process.exit(1);
  }
  insights.suggested_squad = {
    cost: opt.cost / 10,
    remaining: opt.remaining / 10,
    formation: opt.formation,
    projected: +opt.projected.toFixed(1),
    captain: opt.captain?.web_name,
    xi: opt.xi.map(slim),
    bench: opt.bench.map(slim),
  };
  console.log(`Suggested squad: £${(opt.cost / 10).toFixed(1)}m, ${opt.formation}, ${opt.projected.toFixed(1)} projected over ${HORIZON} GWs`);
  console.log(opt.xi.map((p) => `${POS[p.element_type]} ${p.web_name} (${teams[p.team]}) £${p.price.toFixed(1)}m`).join('\n'));
}

await writeJSON('data/insights.json', insights);
console.log(`\n✓ data/insights.json written — ${rows.length} players projected from GW${ctx.fromEvent}`);
