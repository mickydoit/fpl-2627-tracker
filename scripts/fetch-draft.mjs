/**
 * Fetch FPL Draft data. Server-side only — the Draft API sends no CORS
 * headers, exactly like the main game's.
 *
 * DRAFT_LEAGUE_ID is optional: without it we still get the player pool, which
 * is all the pre-draft board needs.
 */
import { getJSON } from './lib/http.mjs';
import { writeJSONIfChanged } from './lib/io.mjs';
import { mkdir } from 'node:fs/promises';

const API = 'https://draft.premierleague.com/api';
const LEAGUE = process.env.DRAFT_LEAGUE_ID;
const DIR = 'data/draft';

await mkdir(DIR, { recursive: true });

console.log('→ draft bootstrap-static');
const boot = await getJSON(`${API}/bootstrap-static`, { browserUA: true });
if (!boot?.elements?.length) throw new Error('draft bootstrap returned no players');
await writeJSONIfChanged(`${DIR}/bootstrap.json`, boot);
console.log(`  ${boot.elements.length} players`);

if (LEAGUE) {
  console.log(`→ league ${LEAGUE}`);
  const details = await getJSON(`${API}/league/${LEAGUE}/details`, { browserUA: true })
    .catch((e) => { console.warn(`  league details failed: ${e.message}`); return null; });
  if (details) await writeJSONIfChanged(`${DIR}/league.json`, details);

  const choices = await getJSON(`${API}/draft/${LEAGUE}/choices`, { browserUA: true })
    .catch((e) => { console.warn(`  choices failed: ${e.message}`); return null; });
  if (choices) {
    await writeJSONIfChanged(`${DIR}/choices.json`, choices);
    const owned = (choices.element_status || []).filter((e) => e.owner).length;
    console.log(`  ${choices.choices?.length || 0} picks made, ${owned} players owned`);
  }
} else {
  console.log('  DRAFT_LEAGUE_ID not set — player pool only.');
}

console.log('✓ draft data written');
