/**
 * Project the board over both horizons.
 *
 * Evidence comes from the frozen 2025/26 prior, not from mutable bootstrap
 * fields — those are zeroed at the GW1 deadline, and a board that silently
 * loses its evidence base mid-season is worse than one that never had it.
 *
 * Two horizons are produced. A first-round pick is a season-long asset, so the
 * rest-of-season number carries most of the weight; the near-term number is
 * there for the marginal late-round picks where role and fixtures dominate.
 */
import { projectAll, availability } from '../model.js';
import { draftPrior } from './adapt.js';
import { DRAFT_CONFIG } from './config.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const per90 = (total, minutes) => (minutes > 0 ? (num(total) / minutes) * 90 : 0);

/**
 * Reshape a board row into what js/model.js expects: per-90 rates derived from
 * the frozen season totals, with live availability from the current payload.
 */
export function toModelRow(p) {
  const prior = p.prior || {};
  const mins = num(prior.minutes);
  return {
    ...prior,
    id: p.id,
    code: p.code,
    element_type: p.element_type,
    team: p.team,
    web_name: p.web_name,
    status: p.status,
    chance_of_playing_next_round: p.chance_of_playing_next_round,
    news: p.news,
    now_cost: p.now_cost,
    draft_rank: p.draft_rank,
    penalties_order: p.penalties_order,
    minutes: mins,
    expected_goals_per_90: per90(prior.expected_goals, mins),
    expected_assists_per_90: per90(prior.expected_assists, mins),
    expected_goals_conceded_per_90: per90(prior.expected_goals_conceded, mins),
    saves_per_90: per90(prior.saves, mins),
    defensive_contribution_per_90: per90(prior.defensive_contribution, mins),
  };
}

export function projectBoard(boardPlayers, fixtures, teams, opts = {}) {
  const rows = boardPlayers.map(toModelRow);
  // Real strength ratings from the committed dataset feed js/model.js's
  // teamDefence() fallback for clubs with too little prior-season data (newly
  // promoted sides). Without them every under-informed club collapses to the
  // identical league-average xGC — synthesize bare `{id}` rows only for a
  // dataset built before teams were carried through.
  const teamRows = Array.isArray(teams) && teams.length
    ? teams
    : [...new Set(rows.map((r) => r.team))].map((id) => ({ id }));
  const boot = { elements: rows, teams: teamRows, events: [{ id: 1, is_next: true }] };

  const ros = projectAll(boot, fixtures, {
    horizon: DRAFT_CONFIG.rosHorizon, prior: draftPrior, ...opts,
  });
  const near = projectAll(boot, fixtures, {
    horizon: DRAFT_CONFIG.nearTermHorizon, prior: draftPrior, ...opts,
  });
  const nearById = new Map(near.rows.map((r) => [r.id, r.proj]));

  return ros.rows.map((r) => ({
    id: r.id,
    code: r.code,
    element_type: r.element_type,
    team: r.team,
    web_name: r.web_name,
    news: r.news || '',
    status: r.status,
    availability: availability(r),
    minutes: r.minutes,
    draft_rank: r.draft_rank,
    now_cost: r.now_cost,   // shown, never ranked on
    proj: r.proj,
    rosValue: r.proj,
    nearTermValue: nearById.get(r.id) ?? 0,
    parts: r.parts,
  }));
}
