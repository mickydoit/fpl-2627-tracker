/**
 * Durable, cross-source identity for teams and players.
 *
 * ── Why this is the highest-risk file in the warehouse ──
 *
 * Everything the research layer will eventually claim — that a Bundesliga xG
 * translates a certain way, that a promoted club's defence carries over, that a
 * signing keeps his role — is a statement about a specific human or club
 * followed across a boundary. Join them wrongly and the error is invisible:
 * another player's Bundesliga season silently becomes this one's evidence, the
 * model fits on it, and nothing in any test goes red.
 *
 * So this file inherits the rules of scripts/build-identity.mjs verbatim, and
 * adds one:
 *
 *   1. Never map an ambiguous name. Two candidates means UNMAPPED.
 *   2. Never let two source records claim one another's counterpart.
 *   3. Emit the failures, so gaps are visible rather than silently absent.
 *   4. Key on stable source ids, never on names.
 *   5. NEW — a cross-source player join must agree on DATE OF BIRTH. Names
 *      collide across leagues far more than they do inside one; date of birth
 *      is the attribute that makes two records the same footballer rather than
 *      two footballers with the same name. A name-only agreement is recorded as
 *      a PROPOSAL and never as a mapping.
 *
 * ── What joins to what ──
 *
 *   FPL code  ──(existing data/identity/players.json)──>  ESPN athlete id + DOB
 *   ESPN DOB + name  ──(this file)──>  football-data player id + nationality
 *
 * FPL publishes no date of birth at all, which is why the chain runs through
 * ESPN rather than joining FPL to football-data directly.
 */
import fs from 'node:fs';
import { readRows, writeRows, paths, ROOT } from './store.mjs';
import { COMPETITIONS, seasonsFor } from './config.mjs';
import { canonicalTla } from './tla.mjs';

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

/** Accents fold away; ß and the Scandinavian vowels do not decompose. */
const norm = (s) => (s || '')
  .replace(/ß/g, 'ss').replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/đ/gi, 'd').replace(/ł/gi, 'l')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/* Club code vocabulary lives in tla.mjs — one table, two consumers. */

const boot = readJSON('data/bootstrap.json');
const fplIdentity = readJSON('data/identity/players.json');
if (!boot?.teams?.length) {
  console.warn('✗ no bootstrap — leaving any committed identity untouched');
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * teams
 * ------------------------------------------------------------------ */
const fplByTla = new Map(boot.teams.map((t) => [t.short_name, t]));
const teams = new Map();   // canonical key → row
const teamProblems = [];

/* football-data is the spine: its club ids are stable across seasons AND
   across competitions, which is the property that lets a club be followed out
   of the Championship and into the Premier League. */
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const season of seasonsFor('football-data')) {
    for (const t of await readRows(paths.fdTeams(comp.key, season))) {
      const key = `fd:${t.teamId}`;
      const prev = teams.get(key) || {
        globalTeamId: key,
        name: t.name,
        shortName: t.shortName,
        tla: t.tla,
        footballDataId: t.teamId,
        fplTeamId: null,
        fplShort: null,
        espnTeamId: null,
        espnName: null,
        seasons: [],
      };
      prev.seasons.push({ competition: comp.key, season });
      teams.set(key, prev);
    }
  }
}

/* The FPL join, done AFTER every club is known so it can be restricted and
   checked rather than applied optimistically inside the loop.
   
   Two rules, both learned the hard way:
   
   1. Only a club that has actually played in eng.1 may claim an FPL team id.
      FPL contains Premier League clubs and nothing else, so matching on the
      three-letter code alone reaches across leagues — Brentford FC and Stade
      Brestois 29 are both "BRE", and without this restriction Brest's seasons
      were attributed to Brentford. A cross-league club collision is exactly the
      error this file exists to prevent and it produced no symptom at all.
   
   2. One FPL club, one claimant. A second claim is recorded as a problem rather
      than overwriting the first, because whichever won would be arbitrary. */
const fplClaimed = new Map();
for (const row of teams.values()) {
  const playedInEpl = row.seasons.some((s) => s.competition === 'eng.1');
  if (!playedInEpl) continue;
  const tla = canonicalTla('football-data', row.tla, 'eng.1');
  const fpl = fplByTla.get(tla);
  if (!fpl) continue;
  if (fplClaimed.has(fpl.id)) {
    teamProblems.push({
      globalTeamId: row.globalTeamId, name: row.name, tla: row.tla,
      reason: `FPL team ${fpl.short_name} already claimed by ${fplClaimed.get(fpl.id)}`,
    });
    continue;
  }
  fplClaimed.set(fpl.id, row.globalTeamId);
  row.fplTeamId = fpl.id; row.fplShort = fpl.short_name;
}

/* ESPN joins on club NAME, not on its three-letter code: the codes collide
   across leagues (several "MAN"s, several "BRE"s) while displayName does not
   inside a single competition. */
const espnTeams = new Map();
for (const comp of COMPETITIONS) {
  for (const season of seasonsFor('espn')) {
    for (const m of await readRows(paths.espnMatches(comp.key, season))) {
      for (const t of m.teams) {
        if (t.espnTeamId) espnTeams.set(t.espnTeamId, { id: t.espnTeamId, name: t.name, abb: t.abbreviation });
      }
    }
  }
}
const byNormName = new Map();
for (const row of teams.values()) {
  for (const n of [row.name, row.shortName]) {
    if (!n) continue;
    const k = norm(n).replace(/\b(fc|afc|cf|sc)\b/g, '').replace(/\s+/g, ' ').trim();
    if (!byNormName.has(k)) byNormName.set(k, []);
    byNormName.get(k).push(row);
  }
}
const espnClaimed = new Set();
for (const et of espnTeams.values()) {
  const k = norm(et.name).replace(/\b(fc|afc|cf|sc)\b/g, '').replace(/\s+/g, ' ').trim();
  /* Dedupe by club before counting candidates. A club is indexed under both
     its full name and its short name, and for most of them those normalise to
     the same string once "FC" is stripped — so "Arsenal FC"/"Arsenal" put the
     SAME row in the bucket twice and every club looked ambiguous to itself. */
  const hits = [...new Map((byNormName.get(k) || []).map((r) => [r.globalTeamId, r])).values()];
  if (hits.length !== 1) {
    teamProblems.push({ espnTeamId: et.id, espnName: et.name, candidates: hits.length, reason: hits.length ? 'ambiguous' : 'no football-data club' });
    continue;
  }
  const row = hits[0];
  if (row.espnTeamId && row.espnTeamId !== et.id) {
    teamProblems.push({ espnTeamId: et.id, espnName: et.name, reason: `already claimed by espn ${row.espnTeamId}` });
    continue;
  }
  if (espnClaimed.has(et.id)) continue;
  row.espnTeamId = et.id; row.espnName = et.name; espnClaimed.add(et.id);
}

/* ------------------------------------------------------------------ *
 * players
 * ------------------------------------------------------------------ */
const fdPlayers = new Map();  // footballDataId → {name, dob, nationality, seen[]}
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const season of seasonsFor('football-data')) {
    for (const t of await readRows(paths.fdTeams(comp.key, season))) {
      for (const p of t.squad || []) {
        const prev = fdPlayers.get(p.playerId) || {
          playerId: p.playerId, name: p.name, dateOfBirth: p.dateOfBirth ?? null,
          nationality: p.nationality ?? null, seen: [],
        };
        prev.seen.push({ competition: comp.key, season, teamId: t.teamId, teamName: t.name, position: p.position ?? null });
        fdPlayers.set(p.playerId, prev);
      }
    }
  }
}

/* Index football-data players by date of birth. DOB is the discriminator; the
   name is only ever a confirmation on top of it. */
const fdByDob = new Map();
for (const p of fdPlayers.values()) {
  if (!p.dateOfBirth) continue;
  if (!fdByDob.has(p.dateOfBirth)) fdByDob.set(p.dateOfBirth, []);
  fdByDob.get(p.dateOfBirth).push(p);
}

const players = [];
const proposals = [];
const unmapped = [];
const fdClaimed = new Map();

for (const [code, m] of Object.entries(fplIdentity?.players || {})) {
  const row = {
    globalPlayerId: `fpl:${code}`,
    fplCode: Number(code),
    fplId: m.fplId ?? null,
    name: m.name,
    espnId: m.espnId ?? null,
    espnName: m.espnName ?? null,
    dateOfBirth: m.dateOfBirth ?? null,
    footballDataId: null,
    nationality: null,
    method: null,
    confidence: null,
  };

  if (!row.dateOfBirth) {
    unmapped.push({ code: Number(code), name: m.name, reason: 'no date of birth on the ESPN side to join with' });
    players.push(row); continue;
  }
  const sameDob = fdByDob.get(row.dateOfBirth) || [];
  if (!sameDob.length) {
    unmapped.push({ code: Number(code), name: m.name, dateOfBirth: row.dateOfBirth, reason: 'no football-data player born that day in the collected competitions' });
    players.push(row); continue;
  }

  /* Same DOB is necessary, not sufficient — roughly one day in 3,000 collides.
     The name must agree too, on full name or on surname. */
  const target = norm(m.espnName || m.name);
  const surname = target.split(' ').slice(-1)[0];
  const exact = sameDob.filter((p) => norm(p.name) === target);
  const bySurname = sameDob.filter((p) => norm(p.name).split(' ').includes(surname));
  const hits = exact.length ? exact : bySurname;
  const method = exact.length ? 'dob+full-name' : 'dob+surname';

  if (hits.length !== 1) {
    (hits.length ? proposals : unmapped).push({
      code: Number(code), name: m.name, dateOfBirth: row.dateOfBirth,
      candidates: sameDob.map((p) => ({ footballDataId: p.playerId, name: p.name })),
      reason: hits.length ? `${hits.length} share the date of birth and the name` : 'date of birth matched but no name did',
    });
    players.push(row); continue;
  }
  const hit = hits[0];
  if (fdClaimed.has(hit.playerId)) {
    unmapped.push({ code: Number(code), name: m.name, reason: `football-data ${hit.playerId} already claimed by FPL code ${fdClaimed.get(hit.playerId)}` });
    players.push(row); continue;
  }
  fdClaimed.set(hit.playerId, Number(code));
  row.footballDataId = hit.playerId;
  row.nationality = hit.nationality;
  row.method = method;
  row.confidence = exact.length ? 'high' : 'medium';
  players.push(row);
}

/* ------------------------------------------------------------------ */
const teamRows = [...teams.values()];
await writeRows(paths.teams(), teamRows);
await writeRows(paths.players(), players);

const summary = {
  builtAt: new Date().toISOString(),
  teams: {
    total: teamRows.length,
    withFpl: teamRows.filter((t) => t.fplTeamId).length,
    withEspn: teamRows.filter((t) => t.espnTeamId).length,
    problems: teamProblems.length,
  },
  players: {
    fplTotal: boot.elements.length,
    inFplEspnMap: Object.keys(fplIdentity?.players || {}).length,
    mappedToFootballData: players.filter((p) => p.footballDataId).length,
    byMethod: players.reduce((a, p) => { if (p.method) a[p.method] = (a[p.method] || 0) + 1; return a; }, {}),
    proposals: proposals.length,
    unmapped: unmapped.length,
  },
  footballDataPlayersSeen: fdPlayers.size,
};
fs.mkdirSync(`${ROOT}/mappings`, { recursive: true });
fs.writeFileSync(`${ROOT}/mappings/identity-report.json`, JSON.stringify({ ...summary, teamProblems, proposals, unmapped }, null, 1));

console.log('teams');
console.log(`  ${summary.teams.total} clubs, ${summary.teams.withFpl} joined to FPL, ${summary.teams.withEspn} joined to ESPN`
  + `, ${summary.teams.problems} problems`);
console.log('players');
console.log(`  ${summary.players.inFplEspnMap} in the FPL-ESPN map, ${summary.players.mappedToFootballData} also mapped to football-data`);
console.log(`  by method: ${JSON.stringify(summary.players.byMethod)}`);
console.log(`  ${summary.players.proposals} proposals (name+DOB ambiguous, NOT mapped), ${summary.players.unmapped} unmapped`);
console.log(`  football-data players seen across the collected competitions: ${fdPlayers.size}`);
console.log(`\n→ ${ROOT}/mappings/identity-report.json`);
