/**
 * Freeze the 2025/26 evidence before FPL zeroes it at the GW1 deadline.
 *
 * One-shot and idempotent: reads the raw payloads captured in data/draft/raw/
 * and writes a normalised, durable prior keyed by player `code`. Nothing in the
 * refresh workflow may ever overwrite the output — once bootstrap is zeroed,
 * this file is the only surviving record of last season's evidence.
 */
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { writeJSON } from './lib/io.mjs';

/* The raw captures are stored gzipped: they are 2.2 MB of one-off archive that
   nothing reads at runtime, and they compress by 92%. */
const readRaw = async (path) => JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));

const RAW_CLASSIC = 'data/draft/raw/classic-bootstrap-2026-08-17.json.gz';
const RAW_DRAFT = 'data/draft/raw/draft-bootstrap-2026-08-17.json.gz';
const OUT = 'data/draft/prior-2526.json';

// Season totals arrive as strings for the expected-goals family and as numbers
// elsewhere. Coerce everything so downstream maths never sees "0.00".
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const FIELDS = [
  'minutes', 'starts', 'total_points', 'points_per_game',
  'goals_scored', 'assists', 'clean_sheets', 'goals_conceded',
  'saves', 'penalties_saved', 'penalties_missed', 'own_goals',
  'yellow_cards', 'red_cards',
  'expected_goals', 'expected_assists', 'expected_goal_involvements',
  'expected_goals_conceded',
  'bps', 'bonus',
  'clearances_blocks_interceptions', 'tackles', 'recoveries',
  'defensive_contribution',
];

const classic = await readRaw(RAW_CLASSIC);
const draft = await readRaw(RAW_DRAFT);
if (!classic?.elements?.length) throw new Error(`no classic payload at ${RAW_CLASSIC}`);
if (!draft?.elements?.length) throw new Error(`no draft payload at ${RAW_DRAFT}`);

// draft_rank lives only in the Draft payload. Join on code — ids collide.
const draftByCode = new Map(draft.elements.map((p) => [p.code, p]));

const players = {};
for (const p of classic.elements) {
  const d = draftByCode.get(p.code);
  const row = {
    code: p.code,
    web_name: p.web_name,
    first_name: p.first_name,
    second_name: p.second_name,
    element_type: p.element_type,
    team: p.team,
    draft_rank: d ? num(d.draft_rank) : null,
  };
  for (const f of FIELDS) row[f] = num(p[f]);
  players[p.code] = row;
}

await writeJSON(OUT, {
  season: '2025/26',
  capturedAt: new Date().toISOString(),
  source: { classic: RAW_CLASSIC, draft: RAW_DRAFT },
  players,
});

const n = Object.keys(players).length;
const mins = Object.values(players).reduce((s, p) => s + p.minutes, 0);
console.log(`✓ froze ${n} players, ${mins} minutes of evidence → ${OUT}`);
