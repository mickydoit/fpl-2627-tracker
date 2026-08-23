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
  bonusModel: null,     // (player) => expected bonus per appearance; defaults to the BPS logistic
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
 * Minutes as the model should read them.
 *
 * `minutes` is what a player actually played this season and stays that way so
 * pages can show it honestly. js/prior.js pools two seasons and publishes the
 * result as `modelMinutes`, on a games basis shared by every player, because a
 * zeroed August leaves the raw figure with nothing in it. Everything that
 * reasons about playing time goes through here so the two never drift apart.
 */
const modelMinutes = (p) => num(p.modelMinutes) || num(p.minutes);

/**
 * Games played league-wide, inferred from the busiest player's minutes.
 * FPL zeroes teams[].played all season, so there is no direct source.
 *
 * Once a prior is blended in this is the pooled basis rather than a count of
 * real matches, which is what `modelMinutes` is expressed against.
 */
export function inferGamesPlayed(players) {
  const max = players.reduce((m, p) => Math.max(m, modelMinutes(p)), 0);
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
    /* Eligibility is a question about evidence, not about role, so it reads
       evidenceMinutes. modelMinutes is rebuilt onto a pooled basis by
       js/prior.js and clears 450 on a single appearance — which rated three
       newly promoted clubs off one match each, Ipswich as the best defence in
       the league. A club with no Premier League history now stays on its
       strength rating until it has really played. */
    const mins = num(p.evidenceMinutes) || modelMinutes(p);
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
    // NOT `finished`: that only flips after FPL's confirmation pass the morning
    // after the gameweek's last match. A match kicked off hours ago still reads
    // finished:false, and projecting it again would double-count points the
    // live payload already holds.
    if (f.started || f.finished || f.finished_provisional) continue;
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
  const mins = modelMinutes(p);

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

  /* defensive contribution
   *
   * Threshold scoring, so it is a probability question, not a rate one:
   * two points if the player reaches the threshold in a match, nothing below
   * it, nothing extra above it.
   *
   * `defensive_contribution_per_90` is the volume of qualifying actions per 90,
   * and FPL already counts the right actions per position — CBIT for defenders,
   * CBIRT for midfielders and forwards, which is verifiable by reconstructing
   * it from the raw columns. So it feeds the threshold directly.
   *
   * It was previously read as if it were scoring occurrences and clamped into
   * [0,1], which handed every outfielder the full two points: the rates run
   * from about 3 to 16, so the clamp saturated for 100% of players and the
   * component discriminated between nobody. Haaland scored the same defensive
   * contribution as a centre-back.
   *
   * Expected minutes belong inside the rate, not outside the probability. A
   * player who lasts an hour accumulates two thirds of the actions, and his
   * chance of reaching ten is far below two thirds of a full game's chance —
   * scaling the probability afterwards would model a different, easier game.
   */
  let defcon = 0;
  if (pos >= 2) {
    const per90 = num(p.defensive_contribution_per_90) || (mins > 0
      // Older or partial data: rebuild from the raw action counts.
      ? ((num(p.clearances_blocks_interceptions) + num(p.tackles)
        + (pos >= 3 ? num(p.recoveries) : 0)) / mins) * 90
      : 0);
    if (per90 > 0) {
      const expectedActions = per90 * minsFactor;
      defcon = poissonAtLeast(expectedActions, DEFCON_THRESHOLD[pos]) * DEFCON_PTS;
    }
  }

  /* bonus — the injected model where one is supplied, otherwise the historic
     logistic map from bps per 90. The draft engine supplies a 2026/27
     reconstruction; the classic pages deliberately keep the old behaviour. */
  let bonus;
  if (o.bonusModel) {
    bonus = o.bonusModel(p) * minsFactor;
  } else {
    const bps90 = mins > 0 ? (num(p.bps) / mins) * 90 : 0;
    bonus = (1.9 / (1 + Math.exp(-(bps90 - o.bonusCentre) / o.bonusSpread))) * minsFactor;
  }

  /* cards */
  const cards = mins > 0 ? -((num(p.yellow_cards) / mins) * 90 * minsFactor) : 0;

  const modelled = appearance + attack + cleanSheet + conceded + saves + defcon + bonus + cards;

  /* blend against a price prior until there is enough evidence
   *
   * `minutes` answers "how much does he play", and with a single season on
   * record it also answered "how much do we know". Those come apart once
   * js/prior.js pools two seasons: it rebuilds minutes onto a shared games
   * basis so expected minutes stay right, which would otherwise hand a player
   * with one appearance and no prior season the confidence of a full campaign.
   * `evidenceMinutes` is the minutes actually observed, and only that governs
   * how far we move off the price prior. */
  const evidence = num(p.evidenceMinutes) || mins;
  const w = clamp(evidence / o.priorBlendMinutes, 0, 1);
  const prior = (o.prior || pricePrior)(p) * attMult;
  const blended = w * modelled + (1 - w) * prior;

  const riskMult = 1 - o.riskAversion * (1 - avail);
  const total = Math.max(0, blended * avail * riskMult);

  /* The breakdown has to add up to the number it explains, or it is decoration.
     Each modelled route survives into the total only after the prior blend and
     the availability/risk discount, so the contribution of a route is its raw
     value times those same factors. What the prior supplies is a route in its
     own right — without it the components would silently fall short of the
     total by exactly the prior's share. */
  const k = avail * riskMult;
  const share = total > 0 ? w * k : 0;
  const contrib = {
    appearance: appearance * share,
    attack: attack * share,
    cleanSheet: cleanSheet * share,
    conceded: conceded * share,
    saves: saves * share,
    defcon: defcon * share,
    bonus: bonus * share,
    cards: cards * share,
    prior: total > 0 ? (1 - w) * prior * k : 0,
  };

  return {
    total,
    contrib,
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
  const sum = { appearance: 0, attack: 0, cleanSheet: 0, conceded: 0, saves: 0, defcon: 0, bonus: 0, cards: 0, prior: 0 };
  const acc = { expMins: 0, pCS: 0, attMult: 0, availability: 0, evidence: 0 };
  let last = null;
  for (const f of fixtures) {
    const r = projectFixture(p, f, ctx, o);
    total += r.total;
    perGW[f.event] = (perGW[f.event] || 0) + r.total;
    if (r.contrib) for (const k of Object.keys(sum)) sum[k] += r.contrib[k] || 0;
    if (r.parts) {
      for (const k of Object.keys(acc)) acc[k] += r.parts[k] ?? 0;
      last = r.parts;
    }
  }
  const n = fixtures.length || 1;
  /* Components are summed over the whole horizon, so they add up to the number
     on the card. The per-match context around them is averaged instead — an
     expected-minutes figure summed over five fixtures would be meaningless. */
  return {
    total,
    perGW,
    count: fixtures.length,
    parts: {
      ...sum,
      expMins: acc.expMins / n,
      pCS: acc.pCS / n,
      attMult: acc.attMult / n,
      availability: acc.availability / n,
      evidence: acc.evidence / n,
      isPrior: (acc.evidence / n) < 0.5,
      fixtures: fixtures.length,
      perFixture: last,
    },
  };
}

/**
 * The first gameweek a transfer made right now can actually affect.
 *
 * Not the same question as "what will this player score from here". Once a
 * gameweek's deadline passes its squads are locked, so a transfer made during
 * it earns nothing from any of its remaining matches — not even from clubs
 * that have yet to kick off. Projecting a transfer over a window that includes
 * those fixtures credits the incoming player with points he cannot deliver.
 *
 * That is not hypothetical: mid-GW1 it made Tavernier look 4.4 points better
 * than Schade purely because Bournemouth had not played yet, when Schade was
 * the better player per match.
 *
 * Keyed on event deadlines rather than on fixture kickoffs, because the
 * deadline is what locks the squad. Blank and double gameweeks therefore keep
 * their real shape: this decides WHERE the window starts, never how many
 * fixtures a gameweek contains.
 *
 * @returns {number|null} event id, or null once the season has no deadlines left
 */
export function actionableEvent(events, now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : now;
  let best = null;
  for (const e of events || []) {
    if (!e?.deadline_time) continue;
    const d = new Date(e.deadline_time).getTime();
    if (!Number.isFinite(d) || d <= t) continue;
    if (best === null || e.id < best) best = e.id;
  }
  return best;
}

/**
 * Build the shared context once, then reuse it for every player.
 */
export function buildContext(boot, fixtures, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const events = boot.events || [];
  const current = events.find((e) => e.is_current)?.id ?? null;
  const next = events.find((e) => e.is_next)?.id ?? 1;
  /* FPL flips is_next to the following gameweek the moment the deadline passes,
     while the current one still has matches to play — fixtures run Friday to
     Monday, so that is true for most of every week. Keying the window off it
     dropped every unplayed fixture in the current gameweek: on 22 Aug 2026,
     Haaland's match the next day was in neither his live points nor his
     projection. Start from the earliest gameweek that still has a fixture to
     play; upcomingByTeam skips the ones already played. */
  const unplayed = fixtures
    .filter((f) => f.event != null && !(f.started || f.finished || f.finished_provisional))
    .map((f) => f.event);
  const from = o.fromEvent ?? (unplayed.length ? Math.min(...unplayed) : next);
  return {
    games: inferGamesPlayed(boot.elements),
    defence: teamDefence(boot.elements, boot.teams),
    upcoming: upcomingByTeam(fixtures, from, o.horizon),
    teams: Object.fromEntries((boot.teams || []).map((t) => [t.id, t])),
    fromEvent: from,
    currentEvent: current,
    nextEvent: next,
    // Where a transfer decided now can start earning. Callers projecting the
    // value of a transfer should pass this as fromEvent; callers projecting
    // what a player will score from here should not.
    actionableEvent: actionableEvent(events),
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
