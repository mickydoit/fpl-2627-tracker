/**
 * Live draft poller. Run on draft night:
 *
 *   DRAFT_LEAGUE_ID=12345 npm run draft-live
 *
 * The Draft API sends no CORS headers so the page cannot poll it directly, and
 * the scheduled Action runs every 30 minutes against a 60-second pick clock.
 * This bridges the gap: Node polls, the page reads the file same-origin.
 */
import { getJSON } from './lib/http.mjs';
import { writeJSONIfChanged } from './lib/io.mjs';
import { mkdir } from 'node:fs/promises';

const API = 'https://draft.premierleague.com/api';
const LEAGUE = process.env.DRAFT_LEAGUE_ID || process.argv[2];
const EVERY_MS = 5000;
const TERMINAL_STATUS = new Set(['post']);

if (!LEAGUE) {
  console.error('Set DRAFT_LEAGUE_ID (the number in your league URL), e.g.');
  console.error('  DRAFT_LEAGUE_ID=12345 npm run draft-live');
  process.exit(1);
}

await mkdir('data/draft', { recursive: true });
console.log(`Polling league ${LEAGUE} every ${EVERY_MS / 1000}s. Ctrl-C to stop.`);

let lastCount = -1;
for (;;) {
  try {
    const [choices, details] = await Promise.all([
      getJSON(`${API}/draft/${LEAGUE}/choices`, { browserUA: true, retries: 1 }),
      getJSON(`${API}/league/${LEAGUE}/details`, { browserUA: true, retries: 1 }),
    ]);
    if (choices) {
      await writeJSONIfChanged('data/draft/choices.json', choices);
      const n = choices.choices?.length || 0;
      if (n !== lastCount) {
        const last = choices.choices?.[n - 1];
        console.log(`  ${n} picks made${last ? ` — latest: pick ${last.pick}` : ''}`);
        lastCount = n;
      }
    }
    if (details) {
      await writeJSONIfChanged('data/draft/league.json', details);
      const status = details.league?.draft_status;
      // Only a KNOWN-terminal status stops the poller. Any unrecognised value
      // keeps it running: `pre` and `post` are the only values ever observed
      // in the wild, and an in-progress draft has never been sampled. Stopping
      // on "a value I don't recognise" would risk quitting on the first poll
      // of a real draft, which is the failure this script exists to prevent.
      // Running too long is recoverable with Ctrl-C; stopping early is not.
      if (status && TERMINAL_STATUS.has(status)) {
        console.log(`Draft status is "${status}" — draft complete, stopping.`);
        break;
      }
    }
  } catch (e) {
    console.warn(`  poll failed (will retry): ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
