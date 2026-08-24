/**
 * Fetch the 20 club kits, once, and commit them.
 *
 * Run by hand — NOT by the scheduled workflow. Kits change at most once a
 * season, so re-fetching them every 30 minutes would be 40 pointless requests
 * an hour against someone else's CDN for bytes that never move.
 *
 *   node scripts/fetch-kits.mjs
 *
 * Committing them rather than hotlinking follows the same rule as everything
 * else here: the browser only ever reads same-origin files. The pitch then
 * renders identically whether or not fantasy.premierleague.com is up, which
 * around a deadline is not a theoretical concern.
 *
 * FETCHED by `team.code` — FPL's own stable club identifier — but SAVED by
 * `short_name`. The Draft board dataset carries no `code` (checked: its teams
 * have only id/name/short_name/strength), so a code-keyed filename would leave
 * the Draft pitch unable to find a kit. Short names are present in both
 * datasets, stable within a season, and readable in a directory listing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const BASE = 'https://fantasy.premierleague.com/dist/img/shirts/standard';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const OUT = 'img/kits';

const boot = JSON.parse(await readFile('data/bootstrap.json', 'utf8'));
await mkdir(OUT, { recursive: true });

let written = 0; let failed = 0;
for (const team of boot.teams) {
  // `_1` is the goalkeeper variant; keepers score differently and look different.
  for (const [suffix, label] of [['', 'outfield'], ['_1', 'keeper']]) {
    const url = `${BASE}/shirt_${team.code}${suffix}-66.png`;
    const dest = `${OUT}/shirt_${team.short_name}${suffix}.png`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error(`suspiciously small (${buf.length}B)`);
      await writeFile(dest, buf);
      written++;
      process.stdout.write(`  ✓ ${team.short_name} ${label} ${(buf.length / 1024).toFixed(1)}KB\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`  ✗ ${team.short_name} ${label} — ${err.message}\n`);
    }
  }
}
console.log(`\n${written} kits written to ${OUT}/, ${failed} failed`);
process.exit(failed ? 1 : 0);
