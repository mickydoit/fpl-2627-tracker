/**
 * football-data player id ↔ ESPN athlete id, for every player the census saw.
 *
 * ── Why this is separate from build-identity.mjs ──
 *
 * That file answers "who is this FPL player, elsewhere", and is keyed on the
 * 616 players the tracker projects. It is the right shape for production
 * questions and the wrong shape for research ones: promoted-club continuity is
 * measured in the minutes of a Championship squad from three seasons ago, and
 * almost none of those players are in today's FPL bootstrap.
 *
 * So this builds the wider bridge — every football-data squad member against
 * every ESPN roster entry — using the same discipline:
 *
 *   date of birth must agree. It is the discriminator; the name only ever
 *   confirms it. Two candidates on the same day means UNMAPPED, and no pair is
 *   ever joined on a name alone.
 *
 * The scope is what makes it safe. Matching is done WITHIN a competition and
 * season, so the pool at any moment is one league's squads rather than ten
 * seasons of European football — which is what keeps a shared birthday from
 * becoming a coin flip.
 */
import { readRows, writeRows, paths, stamp } from './store.mjs';
import { COMPETITIONS, seasonsFor } from './config.mjs';

const norm = (s) => (s || '')
  .replace(/ß/g, 'ss').replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/đ/gi, 'd').replace(/ł/gi, 'l')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

const xref = new Map();     // `${fdId}:${espnId}` -> row
const stats = { pairs: 0, dobFullName: 0, dobSurname: 0, ambiguous: 0, noDob: 0, noCounterpart: 0 };

for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const season of seasonsFor('football-data')) {
    /* football-data side: squad members with a date of birth. */
    const fd = [];
    for (const t of await readRows(paths.fdTeams(comp.key, season))) {
      for (const p of t.squad || []) {
        if (p.dateOfBirth) fd.push({ id: p.playerId, name: p.name, dob: String(p.dateOfBirth).slice(0, 10), team: t.tla });
      }
    }
    /* ESPN side: the census for the same competition-season. */
    const espn = (await readRows(paths.espnRosters(comp.key, season)))
      .filter((r) => r.dateOfBirth)
      .map((r) => ({ id: r.espnId, name: r.name, dob: r.dateOfBirth, team: r.teamAbbr }));
    if (!fd.length || !espn.length) continue;

    const byDob = new Map();
    for (const e of espn) {
      if (!byDob.has(e.dob)) byDob.set(e.dob, []);
      byDob.get(e.dob).push(e);
    }

    const claimed = new Set();
    for (const f of fd) {
      const sameDob = byDob.get(f.dob) || [];
      if (!sameDob.length) { stats.noCounterpart += 1; continue; }
      const target = norm(f.name);
      const surname = target.split(' ').slice(-1)[0];
      const exact = sameDob.filter((e) => norm(e.name) === target);
      const bySurname = sameDob.filter((e) => norm(e.name).split(' ').includes(surname));
      const hits = exact.length ? exact : bySurname;
      if (hits.length !== 1) { stats.ambiguous += 1; continue; }
      const e = hits[0];
      if (claimed.has(e.id)) continue;
      claimed.add(e.id);
      const key = `${f.id}:${e.id}`;
      if (!xref.has(key)) {
        xref.set(key, stamp({
          footballDataPlayerId: f.id,
          espnId: e.id,
          name: f.name,
          espnName: e.name,
          dateOfBirth: f.dob,
          method: exact.length ? 'dob+full-name' : 'dob+surname',
          confidence: exact.length ? 'high' : 'medium',
          seenIn: [{ competition: comp.key, season }],
        }, { source: 'derived:dob-join', fetchedAt: new Date().toISOString() }));
        stats.pairs += 1;
        if (exact.length) stats.dobFullName += 1; else stats.dobSurname += 1;
      } else {
        xref.get(key).seenIn.push({ competition: comp.key, season });
      }
    }
  }
}

const rows = [...xref.values()];
/* One football-data player must not map to two ESPN athletes, or vice versa.
   Where the census disagrees across seasons the pair is dropped rather than
   picked between — an arbitrary winner is worse than a gap. */
const fdCount = new Map(); const espnCount = new Map();
for (const r of rows) {
  fdCount.set(r.footballDataPlayerId, (fdCount.get(r.footballDataPlayerId) || 0) + 1);
  espnCount.set(r.espnId, (espnCount.get(r.espnId) || 0) + 1);
}
const clean = rows.filter((r) => fdCount.get(r.footballDataPlayerId) === 1 && espnCount.get(r.espnId) === 1);
const dropped = rows.length - clean.length;

await writeRows(paths.playerXref(), clean);

console.log('PLAYER CROSS-REFERENCE  football-data <-> ESPN\n');
console.log(`  pairs formed                 ${rows.length}`);
console.log(`  kept after uniqueness        ${clean.length}`);
console.log(`  dropped as multi-claimed     ${dropped}`);
console.log(`  by method                    dob+full-name ${stats.dobFullName}, dob+surname ${stats.dobSurname}`);
console.log(`  refused as ambiguous         ${stats.ambiguous}`);
console.log(`  no ESPN player born that day ${stats.noCounterpart}`);
console.log(`\n→ ${paths.playerXref()}`);
