/**
 * Projection engine — shared by the browser and the Actions build step.
 *
 * Everything here is a transparent, hand-tuned model rather than a fitted one.
 * Each component maps to a real 2026/27 scoring rule, and every projection ships
 * with a breakdown so you can see *why* a player scores well, not just that he does.
 * Tunables live in DEFAULTS and are exposed in the UI.
 */

export const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/* --- 2026/27 scoring constants (verified against game_config.scoring) --- */
export const GOAL_PTS = { 1: 10, 2: 6, 3: 5, 4: 4 };
export const CS_PTS = { 1: 4, 2: 4, 3: 1, 4: 0 };
export const DEFCON_PTS = 2;
// Unchanged for 2026/27: DEF need 10 (clearances, blocks, interceptions, tackles);
// MID/FWD need 12 (the same, plus ball recoveries). GKs are ineligible.
// Capped at 2 points per match no matter how far past the threshold.
export const DEFCON_THRESHOLD = { 2: 10, 3: 12, 4: 12 };

export const SQUAD_RULES = {
  budget: 1000, // tenths of a million
  size: 15,
  perClub: 3,
  select: { 1: 2, 2: 5, 3: 5, 4: 3 },
  minPlay: { 1: 1, 2: 3, 3: 2, 4: 1 },
  maxPlay: { 1: 1, 2: 5, 3: 5, 4: 3 },
};

export const DEFAULTS = {
  horizon: 5,          // gameweeks to project over
  fdrAttack: 0.11,     // per point of fixture difficulty either side of 3
  fdrDefence: 0.13,
  homeAdvantage: 0.06,
  penaltyBonus: 0.10,  // extra xG/90 for a confirmed first-choice penalty taker
  bonusCentre: 27,     // bps/90 at which ~1 bonus point per game is expected
  bonusSpread: 6,
  benchWeight: 0.12,   // how much a bench slot is worth when optimising
  priorBlendMinutes: 900, // minutes of evidence before we fully trust the data
  riskAversion: 0,     // 0..1, penalises players with injury/rotation doubt
  prior: null,          // (player) => pts/appearance; defaults to pricePrior
};

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Poisson P(X >= k) — used for defensive-contribution threshold probability. */
export function poissonAtLeast(lambda, k) {
  if (lambda <= 0) return 0;
  if (k <= 0) return 1;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let i = 1; i < k; i++) {
    term *= lambda / i;
    cdf += term;
  }
  return clamp(1 - cdf, 0, 1);
}

/**
 * Availability from FPL's status codes.
 * a = available, d = doubtful, i = injured, s = suspended, u/n = unavailable.
 */
export function availability(p) {
  if (p.status === 'u' || p.status === 'n') return 0;
  if (p.status === 'i' || p.status === 's') return 0;
  if (p.status === 'd') {
    const c = p.chance_of_playing_next_round;
    return c === null || c === undefined ? 0.5 : c / 100;
  }
  const c = p.chance_of_playing_next_round;
  if (c !== null && c !== undefined && c < 100) return c / 100;
  return 1;
}

/**
 * Games played league-wide, inferred from the busiest player's minutes.
 * FPL zeroes teams[].played all season, so there is no direct source.
 */
export function inferGamesPlayed(players) {
  const max = players.reduce((m, p) => Math.max(m, num(p.minutes)), 0);
  return Math.max(1, Math.round(max / 90));
}

/** Rough pts-per-game prior from price alone, for players with no minutes yet. */
function pricePrior(p) {
  const m = num(p.now_cost) / 10;
  switch (p.element_type) {
    case 1: return clamp(0.62 * m - 0.65, 0.4, 5.2);
    case 2: return clamp(0.68 * m - 0.85, 0.4, 6.0);
    case 3: return clamp(0.58 * m - 0.95, 0.4, 7.5);
    case 4: return clamp(0.52 * m - 0.85, 0.4, 7.5);
    default: return 2;
  }
}

/* ------------------------------------------------------------------ *
 * team-level defensive strength
 * ------------------------------------------------------------------ */
/**
 * Expected goals conceded per match for each team, averaged over its
 * defenders and keeper. Falls back to FPL's own strength ratings when a
 * promoted side has no Premier League data at all.
 */
export function teamDefence(players, teams) {
  const acc = {};
  for (const p of players) {
    if (p.element_type > 2) continue;
    const mins = num(p.minutes);
    if (mins < 450) continue;
    const xgc90 = num(p.expected_goals_conceded_per_90);
    if (xgc90 <= 0) continue;
    (acc[p.team] ||= []).push({ xgc90, mins });
  }
  const out = {};
  const leagueAvg = 1.42; // long-run Premier League goals conceded per team per match
  for (const t of teams) {
    const rows = acc[t.id];
    if (rows && rows.length >= 3) {
      const totMins = rows.reduce((s, r) => s + r.mins, 0);
      out[t.id] = rows.reduce((s, r) => s + r.xgc90 * r.mins, 0) / totMins;
    } else {
      // strength_overall_* runs 1–5, higher = stronger. Newly promoted sides and
      // pre-season snapshots land here.
      const str = (num(t.strength_overall_home) + num(t.strength_overall_away)) / 2 || 3;
      out[t.id] = clamp(leagueAvg * (1 + (3 - str) * 0.17), 0.7, 2.4);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */
/**
 * Upcoming fixtures per team, keyed by team id. Handles blanks (a team with no
 * fixture in a gameweek) and doubles (two fixtures) — both just fall out of
 * grouping by event.
 */
export function upcomingByTeam(fixtures, fromEvent, horizon) {
  const out = {};
  for (const f of fixtures) {
    if (f.event === null || f.event === undefined) continue;
    if (f.event < fromEvent || f.event >= fromEvent + horizon) continue;
    if (f.finished) continue;
    (out[f.team_h] ||= []).push({
      event: f.event, opponent: f.team_a, home: true,
      difficulty: f.team_h_difficulty, kickoff: f.kickoff_time,
    });
    (out[f.team_a] ||= []).push({
      event: f.event, opponent: f.team_h, home: false,
      difficulty: f.team_a_difficulty, kickoff: f.kickoff_time,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the projection
 * ------------------------------------------------------------------ */
/**
 * Expected FPL points for one player in one fixture.
 * @returns {{total:number, parts:object}}
 */
export function projectFixture(p, fixture, ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pos = p.element_type;
  const games = ctx.games || 1;
  const mins = num(p.minutes);

  const avail = availability(p);
  if (avail <= 0) return { total: 0, parts: { unavailable: true } };

  const expMins = clamp(mins / games, 0, 90);
  const minsFactor = expMins / 90;
  const pPlay = clamp(expMins / 20, 0, 0.99);
  const p60 = clamp((expMins - 25) / 45, 0, 0.97);

  const fdr = fixture?.difficulty ?? 3;
  const home = fixture?.home ?? true;
  const attMult = clamp(1 + (3 - fdr) * o.fdrAttack + (home ? o.homeAdvantage : -o.homeAdvantage), 0.5, 1.6);

  /* appearance */
  const appearance = pPlay + p60;

  /* attacking returns */
  let xg90 = num(p.expected_goals_per_90);
  let xa90 = num(p.expected_assists_per_90);
  // A player newly on penalties won't have that priced into last season's xG.
  if (p.penalties_order === 1) xg90 += o.penaltyBonus;
  const attack = (xg90 * GOAL_PTS[pos] + xa90 * 3) * minsFactor * attMult;

  /* clean sheet and goals conceded */
  const teamXGC = ctx.defence?.[p.team] ?? 1.42;
  const oppStrengthMult = clamp(1 + (fdr - 3) * o.fdrDefence + (home ? -o.homeAdvantage : o.homeAdvantage), 0.5, 1.8);
  const xgcMatch = clamp(teamXGC * oppStrengthMult, 0.25, 3.5);
  const pCS = Math.exp(-xgcMatch);
  const cleanSheet = CS_PTS[pos] * pCS * p60;
  const conceded = pos <= 2 ? -(xgcMatch / 2) * p60 : 0;

  /* keeper saves */
  const saves = pos === 1 ? (num(p.saves_per_90) / 3) * minsFactor : 0;

  /* defensive contribution */
  let defcon = 0;
  if (pos >= 2) {
    const dcRate = num(p.defensive_contribution_per_90);
    if (dcRate > 0) {
      // Already expressed as scoring occurrences per 90 — the cap is inherent.
      defcon = clamp(dcRate, 0, 1) * DEFCON_PTS * minsFactor;
    } else if (mins > 0) {
      // Older or partial data: rebuild from the raw action counts.
      const per90 = (v) => (num(v) / mins) * 90;
      const actions =
        per90(p.clearances_blocks_interceptions) +
        per90(p.tackles) +
        (pos >= 3 ? per90(p.recoveries) : 0);
      defcon = poissonAtLeast(actions, DEFCON_THRESHOLD[pos]) * DEFCON_PTS * minsFactor;
    }
  }

  /* bonus — logistic map from bps per 90 */
  const bps90 = mins > 0 ? (num(p.bps) / mins) * 90 : 0;
  const bonus = (1.9 / (1 + Math.exp(-(bps90 - o.bonusCentre) / o.bonusSpread))) * minsFactor;

  /* cards */
  const cards = mins > 0 ? -((num(p.yellow_cards) / mins) * 90 * minsFactor) : 0;

  const modelled = appearance + attack + cleanSheet + conceded + saves + defcon + bonus + cards;

  /* blend against a price prior until there is enough evidence */
  const w = clamp(mins / o.priorBlendMinutes, 0, 1);
  const prior = (o.prior || pricePrior)(p) * attMult;
  const blended = w * modelled + (1 - w) * prior;

  const riskMult = 1 - o.riskAversion * (1 - avail);
  const total = Math.max(0, blended * avail * riskMult);

  return {
    total,
    parts: {
      appearance, attack, cleanSheet, conceded, saves, defcon, bonus, cards,
      expMins, pCS, xgcMatch, attMult, availability: avail,
      evidence: w, prior, modelled, isPrior: w < 0.5,
    },
  };
}

/**
 * Total projected points across the next `horizon` gameweeks.
 * Blank gameweeks contribute nothing; doubles contribute twice — which is
 * exactly what you want when comparing transfer targets.
 */
export function projectHorizon(p, ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fixtures = ctx.upcoming?.[p.team] || [];
  if (!fixtures.length) {
    return { total: 0, perGW: {}, count: 0, parts: { noFixtures: true } };
  }
  let total = 0;
  const perGW = {};
  let firstParts = null;
  for (const f of fixtures) {
    const r = projectFixture(p, f, ctx, o);
    total += r.total;
    perGW[f.event] = (perGW[f.event] || 0) + r.total;
    if (!firstParts) firstParts = r.parts;
  }
  return { total, perGW, count: fixtures.length, parts: firstParts };
}

/**
 * Build the shared context once, then reuse it for every player.
 */
export function buildContext(boot, fixtures, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const events = boot.events || [];
  const current = events.find((e) => e.is_current)?.id ?? null;
  const next = events.find((e) => e.is_next)?.id ?? 1;
  const from = o.fromEvent ?? next;
  return {
    games: inferGamesPlayed(boot.elements),
    defence: teamDefence(boot.elements, boot.teams),
    upcoming: upcomingByTeam(fixtures, from, o.horizon),
    teams: Object.fromEntries((boot.teams || []).map((t) => [t.id, t])),
    fromEvent: from,
    currentEvent: current,
    nextEvent: next,
    horizon: o.horizon,
  };
}

/** Project every player and attach the result. Returns a new array. */
export function projectAll(boot, fixtures, opts = {}) {
  const ctx = buildContext(boot, fixtures, opts);
  const rows = boot.elements.map((p) => {
    const proj = projectHorizon(p, ctx, opts);
    const price = num(p.now_cost) / 10;
    return {
      ...p,
      pos: POS[p.element_type],
      price,
      proj: proj.total,
      projPerGW: proj.count ? proj.total / proj.count : 0,
      projByGW: proj.perGW,
      fixtureCount: proj.count,
      value: price > 0 ? proj.total / price : 0,
      parts: proj.parts,
      fixtures: ctx.upcoming[p.team] || [],
    };
  });
  return { rows, ctx };
}
