
import { parseReturnBoundary } from './availability-news.js';/**
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
  /**
   * Minutes of ROLE evidence before expected minutes are taken at face value.
   * Lower than the production bar: how much a player features is visible far
   * sooner than how productive he is, because every appearance reports it.
   */
  minutesBlendMinutes: 450,
  riskAversion: 0,     // 0..1, penalises players with injury/rotation doubt
  prior: null,          // (player) => pts/appearance; defaults to pricePrior
  bonusModel: null,     // (player) => expected bonus per appearance; defaults to the BPS logistic
  /**
   * The opportunity constants, as options rather than literals so they can be
   * swept and refitted as the season's sample grows. Measured on GW1 2026/27
   * per-match rows — ONE gameweek, so provisional:
   *
   *   minsPerStart   n=174  mean 83.2  sd 10.5  95% CI [81.7, 84.8]
   *   minsPerSub     n= 42  mean 19.7  sd  9.8  95% CI [16.8, 22.7]
   *   p60GivenStart  170/174 = 0.977   95% CI [0.955, 0.999]
   *
   * `p60GivenStart` is the one to distrust. Only four starters missed sixty
   * minutes and all four were tactical (54, 55, 45, 55); GW1 carried no
   * suspensions and produced no red cards among starters, so 0.977 is an
   * optimistic read of a rate that must fall once those arrive. It is
   * deliberately set BELOW the point estimate — see the note in DEFAULTS.
   */
  minsPerStart: 83.2,
  minsPerSub: 19.7,
  p60GivenStart: 0.977,
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
/**
 * How a player's availability was decided. Recorded so the gameweek archive can
 * later answer "was this projection wrong because production was wrong, minutes
 * were wrong, or availability was wrong" — and, within availability, which kind
 * of evidence produced it.
 */
export const AVAILABILITY_SOURCE = {
  HEALTHY: 'healthy',                       // nothing flagged
  CHANCE_FIELD: 'chance-field',             // FPL gave an explicit percentage
  EXPECTED_RETURN: 'expected-return',       // parsed "Expected back <date>" — an ESTIMATE
  SUSPENSION: 'suspension',                 // parsed "Suspended until <date>" — deterministic
  UNKNOWN_RETURN: 'unknown-return',         // out, and FPL says it does not know when back
  PERMANENT: 'permanent-unavailable',       // left the league; correctly zero forever
};

/** Which bucket a player falls in, before any fixture is considered. */
export function availabilitySource(p) {
  const news = typeof p?.news === 'string' ? p.news : '';
  const parsed = parseReturnBoundary(p);
  if (parsed) {
    return parsed.kind === 'suspension'
      ? AVAILABILITY_SOURCE.SUSPENSION : AVAILABILITY_SOURCE.EXPECTED_RETURN;
  }
  if (p?.status === 'u' || p?.status === 'n') return AVAILABILITY_SOURCE.PERMANENT;
  if (p?.status === 'i' || p?.status === 's') return AVAILABILITY_SOURCE.UNKNOWN_RETURN;
  if (availability(p) < 1) return AVAILABILITY_SOURCE.CHANCE_FIELD;
  return AVAILABILITY_SOURCE.HEALTHY;
}

/**
 * Availability for ONE fixture, rather than one number stretched across the
 * whole horizon.
 *
 * The defect this addresses: a player flagged today projected zero for every
 * remaining gameweek, so a calf strain with a published comeback date erased
 * eight months of football. Availability is a property of a player AND a
 * fixture, and the boundary is compared against that fixture's own kickoff —
 * not the earliest kickoff in the gameweek, which would misjudge a player
 * whose team plays Monday in a week that starts on Friday, and would collapse
 * a double gameweek's two fixtures into one verdict.
 *
 * Only two clauses move anything. Everything else — including the 47 players
 * FPL says it has no return date for — keeps exactly the behaviour it had.
 *
 * @returns {{value: number, source: string}}
 */
export function availabilityForFixture(p, fixture) {
  const base = availability(p);
  const parsed = parseReturnBoundary(p);
  const source = availabilitySource(p);
  if (!parsed) return { value: base, source };

  const ko = fixture?.kickoff ? Date.parse(fixture.kickoff) : NaN;
  /* No kickoff to judge against — a fixture list without times, or a blank.
     Fall back to the flat answer rather than inventing a verdict. */
  if (!Number.isFinite(ko)) return { value: base, source };

  if (ko < parsed.boundary) {
    /* Still inside the ban or the expected absence. `base` rather than a hard
       zero so a non-zero chance FPL publishes is never silently overridden —
       today every parsable case is status i/s with a chance of 0, so this is
       0 in practice, but it fails safe if that ever stops being true. */
    return { value: Math.min(base, 0), source };
  }
  /* Past the boundary. For a suspension that is simply the end of the ban. For
     an expected return it is an APPROXIMATION of FPL's estimate, not a promise
     of fitness — hence the source label, which the archive keeps so the two can
     be told apart when there is enough history to evaluate them. Whether he
     then STARTS is the opportunity model's question, not this one's. */
  return { value: 1, source };
}

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
/**
 * What to show on a player's shirt during a live gameweek.
 *
 * `multiplier` in `entry/{id}/event/{gw}/picks` is 0 for every bench player,
 * 1 for a starter, 2 for the captain and 3 under a triple captain. Multiplying
 * straight through is right for the TEAM total — the bench does not count —
 * and wrong for the shirt, where it displayed 0 for four bench players who had
 * actually scored 0, 1, 2 and 3. FPL's own app shows what a benched player
 * scored, because seeing what you left out is the entire reason to look at a
 * bench.
 *
 * So a multiplier below 1 is treated as 1 for display. Team totals must sum
 * over the starting eleven rather than relying on the bench multiplying to
 * nothing.
 *
 * @param {object} livePlayer a row from `event/{gw}/live` elements
 * @param {object} [pick]     the matching entry pick, if there is one
 */
export function livePointsFor(livePlayer, pick) {
  if (!livePlayer) return null;
  const m = pick?.multiplier ?? 1;
  return num(livePlayer.total_points) * (m >= 1 ? m : 1);
}

export function inferGamesPlayed(players, basis = null) {
  /* Prefer the basis hydrate actually used. Inferring it from the busiest
     player assumes somebody averages a full ninety on the pooled basis, which
     was only ever approximately true: today it is pinned by ESPN-sourced
     players whose minutes arrive through a different path entirely, and any
     change to how minutes are estimated can shift it for everyone at once.
     js/prior.js knows the number exactly, so it now says so. */
  if (Number.isFinite(basis) && basis > 0) return Math.max(1, Math.round(basis));
  const max = players.reduce((m, p) => Math.max(m, modelMinutes(p)), 0);
  return Math.max(1, Math.round(max / 90));
}

/**
 * Expected minutes per match when the record does not say.
 *
 * Neither of the two wrong answers: no evidence is not ninety minutes, and it
 * is not zero either. It is what a player drawn from a Premier League squad
 * plays on average, which is a genuinely conservative thing to assume about
 * someone we cannot describe.
 *
 * **Measured, not chosen.** These are the mean minutes per match by position
 * across every player in the 2025/26 record — the season the prior stands in
 * for — divided by a 38-game season:
 *
 *   GKP 24.3    DEF 30.4    MID 26.8    FWD 21.1
 *
 * An earlier version of this used 45 for outfielders on the reasoning that it
 * sat "below a starter". It does, but it also sits near the 75th percentile of
 * what squad members actually play: DEF p75 is 56 and MID p75 is 47, so 45 was
 * assuming an unknown player featured more than three quarters of real ones.
 * That is not conservative, it is optimistic with a conservative story attached.
 *
 * The distributions are heavily bimodal — every position has a p25 of zero, and
 * keepers are the extreme case because a club's first choice plays every minute
 * and his deputy plays none. The mean is the honest summary of that: it is not
 * a claim that anyone plays 24 minutes, it is the expectation over not knowing
 * which of the two he is.
 *
 * Position-dependent and nothing else. Price does not enter, draft rank does
 * not enter, and availability does not enter here — status is applied
 * separately and multiplicatively, so an unavailable player is suppressed by
 * `availability()` rather than by a smaller minutes prior. A £4.0m defender and
 * a £14m forward with equally empty records get the same opportunity
 * assumption and are separated by their production priors, which is where price
 * belongs.
 */
const MINUTES_PRIOR = { 1: 24, 2: 30, 3: 27, 4: 21 };

/**
 * Measured on GW1 2026/27 per-match rows, not assumed.
 *
 *   started  n=174   mean 83.2 minutes   P(>=60) = 0.977
 *   sub on   n= 42   mean 19.7 minutes   P(>=60) = 0.000   (0 of 42)
 *
 * The second line is the important one. Reaching sixty minutes is almost
 * entirely a question of whether a player STARTS, and barely at all a question
 * of how many minutes he averages — which is what the old `p60` formula asked.
 */
const MINS_PER_START = 83.2;
const MINS_PER_SUB = 19.7;
const P60_GIVEN_START = 0.977;
function minutesPrior(p) {
  return MINUTES_PRIOR[p.element_type] ?? 27;
}

/** Rough pts-per-90 prior from price alone, for players with no minutes yet. */
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

  const { value: avail, source: availSource } = availabilityForFixture(p, fixture);
  if (avail <= 0) return { total: 0, util: 0, parts: { unavailable: true, availSource } };

  /* ---- opportunity ----
   *
   * How much a player plays is a different question from how productive he is,
   * and it is answered by different evidence: every appearance reports minutes,
   * while a shooting rate takes a season to become trustworthy. So the two
   * carry separate confidences and are blended separately.
   *
   * `minutesEvidence` is the minutes actually observed for ROLE purposes. It
   * falls back to the production evidence when a caller does not distinguish
   * them, which keeps older payloads working. */
  const minutesEvidence = num(p.minutesEvidenceMinutes) || num(p.evidenceMinutes) || mins;
  const wMin = clamp(minutesEvidence / o.minutesBlendMinutes, 0, 1);
  const observedMpg = clamp(mins / games, 0, 90);
  const expMins = clamp(wMin * observedMpg + (1 - wMin) * minutesPrior(p), 0, 90);
  const minsFactor = expMins / 90;

  /* ---- appearance probabilities, from the mixture rather than the average ----
   *
   * Both of these used to be straight lines through expected minutes, and both
   * saturated absurdly early: `expMins/20` made anyone averaging twenty minutes
   * a certainty to appear, and `(expMins-25)/45` capped at 68.6 minutes, so a
   * player expected to last 70 and one expected to last 90 scored identical
   * appearance points. In the optimal five-gameweek XI that produced 9.8
   * appearance points for all eleven players across a 71-90 minute spread.
   *
   * js/prior.js now supplies the selection probabilities directly. Where it has
   * not run — raw bootstrap, unit tests — the same mixture is inverted from
   * expected minutes, so both paths agree on what the number means.
   */
  const MPSTART = o.minsPerStart, MPSUB = o.minsPerSub;
  const supplied = Number.isFinite(p.startProbability);
  const pStart = supplied
    ? clamp(num(p.startProbability), 0, 1)
    : clamp((expMins - MPSUB) / (MPSTART - MPSUB), 0, 1);
  const pSubApp = supplied
    ? clamp(num(p.subAppProbability), 0, 1 - pStart)
    : clamp((expMins - pStart * MPSTART) / MPSUB, 0, 1 - pStart);
  const pPlay = clamp(pStart + pSubApp, 0, 0.99);
  const p60 = clamp(pStart * o.p60GivenStart, 0, 0.99);

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
  /* The prior is a RATE — points per ninety on the pitch — and every rate in
     this model passes through the opportunity layer above. It used to be added
     as a finished per-fixture figure, which made the two halves of the blend
     different units and let a player's expected minutes fall while his prior
     stayed whole. That inverted the model: at 23 expected minutes a no-evidence
     player scored 2.44, at 5 minutes 2.73, and at zero minutes 2.99 — knowing
     less made him better. Multiplying by minsFactor is not a patch here; it is
     what makes both sides points-per-fixture. */
  const priorRate = (o.prior || pricePrior)(p) * attMult;
  const prior = priorRate * minsFactor;
  const blended = w * modelled + (1 - w) * prior;

  /* ---- expectation, and preference, kept apart ----------------------------
   *
   * `total` is the model's expected FPL points and nothing else. Availability
   * belongs in it: if the model believes a player has a 50% chance of playing,
   * half of six points IS three points, and that is an expectation, not a
   * preference. What used to sit here as well was `riskMult`, a user setting,
   * which turned that three into 2.25 and still called it expected points.
   *
   * The preference now lives in `util` — the same arithmetic, applied to a
   * separate number that only ranking reads. Rankings are therefore unchanged;
   * what changed is which number is allowed to be called an expectation.
   */
  const total = Math.max(0, blended * avail);
  const riskMult = 1 - o.riskAversion * (1 - avail);
  const util = total * riskMult;

  /* The breakdown has to add up to the number it explains, or it is decoration.
     Each modelled route survives into the total only after the prior blend and
     the availability/risk discount, so the contribution of a route is its raw
     value times those same factors. What the prior supplies is a route in its
     own right — without it the components would silently fall short of the
     total by exactly the prior's share. */
  const k = avail;
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
    util,
    contrib,
    parts: {
      appearance, attack, cleanSheet, conceded, saves, defcon, bonus, cards,
      expMins, pStart, pSubApp, pPlay, p60, pCS, xgcMatch, attMult, availability: avail, availSource,
      /* The minutes a game he has ACTUALLY played, before any shrinkage
         toward the positional prior. `expMins` is deliberately pulled toward
         that prior until 450 minutes of evidence exist, which is right for a
         projection and wrong for any question of the form "is he a starter" —
         two gameweeks in, every ninety-minute player still shrinks to about
         42. Anything asking about selection must read this instead. */
      observedMpg,
      evidence: w, prior, priorRate, modelled, isPrior: w < 0.5,
      /* Kept apart on purpose. A new signing can be well understood as a
         footballer and poorly understood as a selection — 2,600 minutes last
         season says what he does, and says nothing about whether his new
         manager will play him. */
      productionConfidence: w,
      minutesConfidence: wMin,
      minutesEvidence,
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
    return { total: 0, util: 0, perGW: {}, utilGW: {}, count: 0, parts: { noFixtures: true } };
  }
  let total = 0;
  let util = 0;
  const perGW = {};
  const utilGW = {};
  const sum = { appearance: 0, attack: 0, cleanSheet: 0, conceded: 0, saves: 0, defcon: 0, bonus: 0, cards: 0, prior: 0 };
  const acc = { expMins: 0, observedMpg: 0, pStart: 0, pSubApp: 0, pPlay: 0, p60: 0, pCS: 0, attMult: 0, availability: 0, evidence: 0, productionConfidence: 0, minutesConfidence: 0, minutesEvidence: 0 };
  let last = null;
  for (const f of fixtures) {
    const r = projectFixture(p, f, ctx, o);
    total += r.total;
    util += r.util ?? r.total;
    perGW[f.event] = (perGW[f.event] || 0) + r.total;
    /* The same split by gameweek, on the decision side. Captaincy has to be
       chosen per gameweek, and it must be able to choose on the same basis the
       rest of the objective uses — otherwise a doubtful captain escapes the
       risk preference that every other player in the XI is subject to. */
    utilGW[f.event] = (utilGW[f.event] || 0) + (r.util ?? r.total);
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
    util,
    perGW,
    utilGW,
    count: fixtures.length,
    parts: {
      ...sum,
      expMins: acc.expMins / n,
      observedMpg: acc.observedMpg / n,
      pStart: acc.pStart / n,
      pSubApp: acc.pSubApp / n,
      pPlay: acc.pPlay / n,
      p60: acc.p60 / n,
      pCS: acc.pCS / n,
      attMult: acc.attMult / n,
      availability: acc.availability / n,
      evidence: acc.evidence / n,
      // The two confidences stay apart all the way to the card: a new signing
      // can be well understood as a footballer and poorly as a selection.
      productionConfidence: acc.productionConfidence / n,
      minutesConfidence: acc.minutesConfidence / n,
      minutesEvidence: acc.minutesEvidence / n,
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
    games: inferGamesPlayed(boot.elements, boot.modelGamesBasis),
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
      /* Ranking score, never displayed. Equals `proj` at riskAversion 0. */
      util: proj.util,
      utilByGW: proj.utilGW,
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
