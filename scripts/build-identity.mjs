/**
 * Build the FPL ↔ ESPN player identity map.
 *
 * This is the highest-risk file in the project. Every tactical number that
 * follows — role profiles, expected minutes, team style — is joined through
 * this map, and a wrong join is invisible: the wrong player's shots quietly
 * become someone else's evidence and every downstream projection inherits it.
 *
 * So the rules here are deliberately strict:
 *
 *   1. Never map an ambiguous name. Two candidates means UNMAPPED, not
 *      best-guess. An absent role profile costs nothing; a wrong one is acted
 *      on.
 *   2. Never let two FPL players claim one ESPN athlete, or vice versa. That
 *      is a bug in this script, not bad data, and it exits non-zero.
 *   3. Emit the failures. data/identity/unmapped.json lists everyone who did
 *      not match and why, so gaps are visible rather than silently absent.
 *   4. Key on FPL `code`, never `id`. The code is stable across seasons and
 *      across both games; ids are not, and 21 of 587 players already differ
 *      between classic and Draft.
 *
 * Degradation is by design: a player missing from this map keeps every FPL
 * projection he had and simply carries no ESPN-derived evidence.
 */
import { getJSON } from './lib/http.mjs';
import { readJSON, writeJSONIfChanged } from './lib/io.mjs';

const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/eng.1';
const DIR = 'data/identity';

/**
 * ESPN abbreviations that do not agree with FPL's, keyed ESPN → FPL.
 * Twenty rows is small enough to verify by hand once, which is exactly why the
 * team join is done explicitly instead of by fuzzy matching.
 */
const TEAM_ALIAS = { MAN: 'MUN' };

/**
 * Players whose ESPN name cannot be reached from their FPL name by any general
 * rule, keyed by FPL `code` so a transfer or a rename cannot break the entry.
 * Each one is a deliberate, checked decision — this table must never become a
 * dumping ground for "close enough".
 */
const PLAYER_ALIAS = {
  // Abdul Fatawu Issahaku. FPL registers him "Abdul Fatawu", ESPN "Fatawu
  // Issahaku" — the same three names, split differently, so no general rule
  // reaches across.
  531442: 'Fatawu Issahaku',
};

/** Accents fold away; ß and the Scandinavian vowels do not decompose. */
const norm = (s) => (s || '')
  .replace(/ß/g, 'ss').replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/đ/gi, 'd').replace(/ł/gi, 'l')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

const boot = await readJSON('data/bootstrap.json');
if (!boot?.elements?.length) {
  console.error('no bootstrap.json — run the refresh first');
  process.exit(1);
}
if (boot.elements.some((e) => !e.code)) {
  console.error('bootstrap has players without a code; refusing to build a map keyed on it');
  process.exit(1);
}

console.log('→ ESPN teams');
const teamsPayload = await getJSON(`${ESPN}/teams`, { browserUA: true }).catch((e) => {
  console.warn(`  ESPN teams failed: ${e.message}`);
  return null;
});
if (!teamsPayload) {
  console.warn('✗ ESPN unreachable — leaving any committed identity map untouched');
  process.exit(0);
}

const espnTeams = (teamsPayload.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team);
const teamMap = new Map();
const teamProblems = [];
for (const et of espnTeams) {
  const forced = TEAM_ALIAS[et.abbreviation];
  const hit = forced
    ? boot.teams.find((ft) => ft.short_name === forced)
    : boot.teams.find((ft) => {
      const fn = norm(ft.name);
      const en = norm(et.displayName);
      return fn === en || norm(ft.short_name) === norm(et.abbreviation)
        || en.includes(fn) || fn.includes(norm(et.shortDisplayName));
    });
  if (hit) teamMap.set(et.id, hit);
  else teamProblems.push(`${et.displayName} (${et.abbreviation})`);
}
console.log(`  ${teamMap.size}/${boot.teams.length} teams joined`);
if (teamProblems.length) console.warn(`  ✗ unjoined ESPN teams: ${teamProblems.join(', ')}`);

console.log('→ ESPN rosters');
const rosters = [];
for (const [espnTeamId, fplTeam] of teamMap) {
  const r = await getJSON(`${ESPN}/teams/${espnTeamId}/roster`, { browserUA: true }).catch(() => null);
  if (r?.athletes) rosters.push({ espnTeamId, fplTeam, athletes: r.athletes });
}
console.log(`  ${rosters.length} rosters, ${rosters.reduce((s, r) => s + r.athletes.length, 0)} athletes`);

/* ------------------------------------------------------------------ *
 * the join
 * ------------------------------------------------------------------ */
const byCode = new Map();          // fpl code → mapping row
const espnClaimed = new Map();     // espn id → fpl code, to catch double-claims
const ambiguous = [];
const espnUnmatched = [];
const duplicates = [];

/**
 * Matching runs FPL-player-first and in tiers, and a tie at the best available
 * tier is refused outright.
 *
 * Iterating ESPN-first and taking the first hit looked fine and was wrong: two
 * Burrowes at the same club, or a senior and an academy Fofana, both matched
 * the one FPL registration on surname. Whichever was seen first would have won
 * silently. Collecting every candidate and refusing ties is the only way that
 * failure becomes visible instead of becoming data.
 */
const TIERS = ['alias', 'full-name', 'surname', 'mononym', 'contains'];

function candidatesFor(fpl, athletes) {
  const full = norm(`${fpl.first_name} ${fpl.second_name}`);
  const web = norm(fpl.web_name);
  const second = norm(fpl.second_name);
  const first = norm(fpl.first_name);
  const aliasName = PLAYER_ALIAS[fpl.code] ? norm(PLAYER_ALIAS[fpl.code]) : null;

  const out = [];
  for (const a of athletes) {
    const aFull = norm(a.fullName);
    const aLast = norm(a.lastName) || aFull;
    let tier = null;
    if (aliasName && aFull === aliasName) tier = 'alias';
    else if (aFull === full) tier = 'full-name';
    else if (aLast === second || aLast === web) tier = 'surname';
    else if (aFull === first || aFull === web) tier = 'mononym';
    else if (aLast.length > 3 && full.includes(aLast)) tier = 'contains';
    if (tier) out.push({ athlete: a, tier });
  }
  return out;
}

for (const { fplTeam, athletes } of rosters) {
  const squad = boot.elements.filter((e) => e.team === fplTeam.id);
  for (const fpl of squad) {
    const cands = candidatesFor(fpl, athletes);
    if (!cands.length) continue;

    const bestTier = TIERS.find((t) => cands.some((c) => c.tier === t));
    const atBest = cands.filter((c) => c.tier === bestTier);
    if (atBest.length > 1) {
      ambiguous.push({
        code: fpl.code,
        name: fpl.web_name,
        club: fplTeam.short_name,
        candidates: atBest.map((c) => ({ espnId: c.athlete.id, espnName: c.athlete.fullName })),
        reason: `${atBest.length} ESPN athletes matched on ${bestTier}`,
      });
      continue;
    }

    const a = atBest[0].athlete;
    const claimedBy = espnClaimed.get(a.id);
    if (claimedBy && claimedBy !== fpl.code) {
      // Two FPL registrations reaching one ESPN athlete. A stronger match wins
      // — a full-name hit beats a surname hit, which is exactly the Murphy
      // case at Newcastle, where two brothers share a surname and only one is
      // this athlete. Refuse both only when neither is stronger.
      const heldTier = byCode.get(claimedBy)?.method;
      const better = TIERS.indexOf(bestTier) - TIERS.indexOf(heldTier);
      if (better === 0) {
        duplicates.push(`ESPN ${a.fullName} (${a.id}) claimed equally by FPL codes ${claimedBy} and ${fpl.code}`);
        byCode.delete(claimedBy);
        espnClaimed.delete(a.id);
        ambiguous.push({
          code: fpl.code,
          name: fpl.web_name,
          club: fplTeam.short_name,
          candidates: [{ espnId: a.id, espnName: a.fullName }],
          reason: `ESPN athlete matched FPL code ${claimedBy} at the same tier (${bestTier})`,
        });
        continue;
      }
      if (better > 0) continue;            // the existing claim is stronger; leave it
      byCode.delete(claimedBy);            // this claim is stronger; take it over
    }

    espnClaimed.set(a.id, fpl.code);
    byCode.set(fpl.code, {
      code: fpl.code,
      fplId: fpl.id,
      name: fpl.web_name,
      team: fplTeam.short_name,
      espnId: Number(a.id),
      espnName: a.fullName,
      dateOfBirth: a.dateOfBirth ? a.dateOfBirth.slice(0, 10) : null,
      jersey: a.jersey ?? null,
      method: bestTier,
      confidence: bestTier === 'full-name' || bestTier === 'alias' ? 'high' : 'medium',
    });
  }
}

const claimedEspn = new Set(espnClaimed.keys());
for (const { fplTeam, athletes } of rosters) {
  for (const a of athletes) {
    if (!claimedEspn.has(a.id)) espnUnmatched.push({ espnId: a.id, espnName: a.fullName, club: fplTeam.short_name });
  }
}

const fplUnmatched = boot.elements
  .filter((e) => !byCode.has(e.code))
  .map((e) => ({
    code: e.code,
    name: e.web_name,
    team: boot.teams.find((t) => t.id === e.team)?.short_name,
    price: e.now_cost / 10,
    status: e.status,
  }))
  .sort((a, b) => b.price - a.price);

/* ------------------------------------------------------------------ *
 * report and write
 * ------------------------------------------------------------------ */
const byMethod = {};
for (const row of byCode.values()) byMethod[row.method] = (byMethod[row.method] || 0) + 1;

console.log('\nmapped:');
for (const [m, n] of Object.entries(byMethod)) console.log(`  ${m.padEnd(10)} ${n}`);
console.log(`  ${'total'.padEnd(10)} ${byCode.size} / ${boot.elements.length} FPL players`);
console.log(`unmapped FPL players: ${fplUnmatched.length}`);
console.log(`  of those, active and >= £5.0m: ${fplUnmatched.filter((p) => p.price >= 5 && p.status === 'a').length}`);
console.log(`ambiguous, refused:   ${ambiguous.length}`);
console.log(`ESPN athletes with no FPL counterpart: ${espnUnmatched.length}`);

const notable = fplUnmatched.filter((p) => p.price >= 5 && p.status === 'a');
if (notable.length) {
  console.log('\n  active unmapped players worth an alias entry:');
  for (const p of notable.slice(0, 15)) console.log(`    ${String(p.code).padEnd(8)} ${p.name.padEnd(16)} ${p.team} £${p.price.toFixed(1)}`);
}

await writeJSONIfChanged(`${DIR}/players.json`, {
  builtAt: new Date().toISOString(),
  source: 'espn-site-web-api + fpl-bootstrap',
  counts: { mapped: byCode.size, fplTotal: boot.elements.length, ambiguous: ambiguous.length },
  players: Object.fromEntries([...byCode.entries()].map(([code, row]) => [code, row])),
});
await writeJSONIfChanged(`${DIR}/unmapped.json`, {
  builtAt: new Date().toISOString(),
  fplUnmatched,
  ambiguous,
  espnUnmatched,
  teamProblems,
});

if (duplicates.length) {
  // Both sides were refused above, so the map is still safe — but two real
  // people sharing one registration is worth seeing rather than burying.
  console.warn(`\n⚠ ${duplicates.length} contested athletes, all refused:`);
  for (const d of duplicates) console.warn(`   ${d}`);
}
// A genuine invariant break: every mapping must be one-to-one after refusals.
const seen = new Set();
for (const row of byCode.values()) {
  if (seen.has(row.espnId)) {
    console.error(`\n✗ INVARIANT BROKEN — ESPN ${row.espnId} appears twice in the finished map`);
    process.exit(1);
  }
  seen.add(row.espnId);
}
console.log('\n✓ identity map written');
