/**
 * Build the Draft board dataset. Server-side only — the Draft API sends no
 * CORS headers, exactly like the main game's.
 *
 * No league id is involved. The draft assistant is deliberately usable without
 * one, so this script only ever fetches public, league-independent data.
 *
 * On any upstream failure the previous files are left untouched: the browser
 * depends on the committed dataset, never on live API access.
 */
import { getJSON } from './lib/http.mjs';
import { readJSON, writeJSONIfChanged } from './lib/io.mjs';

const DRAFT_API = 'https://draft.premierleague.com/api';
const CLASSIC_API = 'https://fantasy.premierleague.com/api';
const DIR = 'data/draft';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const prior = await readJSON(`${DIR}/prior-2526.json`);
if (!prior?.players) {
  throw new Error('missing data/draft/prior-2526.json — run `npm run freeze-prior` first');
}

console.log('→ draft bootstrap-static');
const draftBoot = await getJSON(`${DRAFT_API}/bootstrap-static`, { browserUA: true })
  .catch((e) => { console.warn(`  draft bootstrap failed: ${e.message}`); return null; });

console.log('→ classic bootstrap-static');
const classicBoot = await getJSON(`${CLASSIC_API}/bootstrap-static/`, { browserUA: true })
  .catch((e) => { console.warn(`  classic bootstrap failed: ${e.message}`); return null; });

if (!classicBoot?.elements?.length) {
  console.warn('✗ no classic payload — leaving the committed dataset untouched');
  process.exit(0);
}

/* The Draft settings are the authoritative scoring rules. If the Draft API is
   down we keep whatever config is already committed rather than inventing one. */
if (draftBoot?.settings) {
  await writeJSONIfChanged(`${DIR}/config.json`, {
    scoring: draftBoot.settings.scoring,
    squad: draftBoot.settings.squad,
    league: draftBoot.settings.league,
  });
  console.log('  wrote scoring + squad config');
} else {
  console.warn('  no draft settings — keeping the committed config');
}

// draft_rank and the Draft element id are enrichments. Join on code: 21 of 587
// players have different ids in the two games, so joining on id is wrong.
const draftByCode = new Map((draftBoot?.elements || []).map((p) => [p.code, p]));

const players = classicBoot.elements.map((p) => {
  const d = draftByCode.get(p.code);
  return {
    code: p.code,
    id: d?.id ?? p.id,
    element_type: p.element_type,
    team: p.team,
    web_name: p.web_name,
    first_name: p.first_name,
    second_name: p.second_name,
    status: p.status,
    chance_of_playing_next_round: p.chance_of_playing_next_round,
    news: p.news || '',
    now_cost: num(p.now_cost), // informational only — never used in ranking
    draft_rank: d ? num(d.draft_rank) : (prior.players[p.code]?.draft_rank ?? null),
    penalties_order: p.penalties_order ?? null,
    prior: prior.players[p.code] ?? null,
  };
}).filter((p) => p.prior);

await writeJSONIfChanged(`${DIR}/players.json`, {
  builtAt: new Date().toISOString(),
  priorSeason: prior.season,
  players,
});
console.log(`✓ ${players.length} players on the board`);
