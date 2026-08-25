/**
 * Why a number is what it is, in a sentence.
 *
 * The design asks for justification text next to every suggestion and a Notes
 * section beside the squad. Three of those sentences in the Figma are three
 * different kinds of claim, and only some can be earned:
 *
 *   "run of 4 fixtures where defence has been weak"     model — computable
 *   "Thigh injury - 75% chance of playing"              FPL — quoted verbatim
 *   "Alonso may not start him, he doesn't fit the style" neither — a human wrote that
 *
 * So this module only ever says things it can point at. Every note carries the
 * source that produced it, and the UI shows that source, because a sentence the
 * model inferred and a sentence FPL published are not the same kind of thing and
 * should not look alike.
 *
 * It computes nothing new. Fixture difficulty, expected minutes, projections and
 * availability all come from rows js/model.js already produced.
 */

/** Sources, in descending order of how much they can be trusted. */
export const SOURCE = {
  FPL: 'fpl',        // published by FPL, quoted word for word
  MODEL: 'model',    // derived from projections and fixtures
  MANUAL: 'manual',  // hand-written in data/manual — carries a date
};

const FDR_HARD = 4;
const FDR_EASY = 2;

/** Upcoming fixtures for a player, as {event, opponent, home, difficulty}. */
export function fixturesFor(player, fixtures, fromEvent, horizon) {
  return (fixtures || [])
    .filter((f) => f.event && f.event >= fromEvent && f.event < fromEvent + horizon)
    .filter((f) => f.team_h === player.team || f.team_a === player.team)
    .map((f) => ({
      event: f.event,
      home: f.team_h === player.team,
      opponent: f.team_h === player.team ? f.team_a : f.team_h,
      difficulty: f.team_h === player.team ? f.team_h_difficulty : f.team_a_difficulty,
    }))
    .sort((a, b) => a.event - b.event);
}

/**
 * How a player's run of fixtures reads, as a phrase — or null when it is
 * unremarkable, which is most of the time. Saying "an average run of fixtures"
 * is noise; the point of a note is that something stands out.
 */
export function fixturePhrase(player, fixtures, teams, fromEvent, horizon = 5) {
  const fx = fixturesFor(player, fixtures, fromEvent, horizon);
  if (!fx.length) return null;
  const hard = fx.filter((f) => f.difficulty >= FDR_HARD);
  const easy = fx.filter((f) => f.difficulty <= FDR_EASY);
  const name = (f) => teams?.[f.opponent]?.short_name || '';
  if (easy.length >= Math.max(2, Math.ceil(fx.length * 0.6))) {
    return { tone: 'good', text: `${easy.length} of the next ${fx.length} look kind — ${easy.slice(0, 3).map(name).join(', ')}` };
  }
  if (hard.length >= Math.max(2, Math.ceil(fx.length * 0.6))) {
    return { tone: 'bad', text: `a hard run — ${hard.slice(0, 3).map(name).join(', ')}` };
  }
  if (fx.length < horizon) {
    return { tone: 'bad', text: `only ${fx.length} fixture${fx.length === 1 ? '' : 's'} in the next ${horizon} gameweeks` };
  }
  return null;
}

/**
 * Notes about one player. Returns [] when there is nothing worth saying, which
 * is the common case and the point — a notes panel that always has something in
 * it is a panel nobody reads.
 */
export function notesFor(player, { fixtures, teams, fromEvent = 1, horizon = 5, manual = null } = {}) {
  const out = [];

  /* FPL's own words first. They are the only thing here that is reported rather
     than inferred, and they are the reason a projection may be wrong. */
  if (player.news && player.news.trim()) {
    const chance = player.chance_of_playing_next_round;
    out.push({
      source: SOURCE.FPL,
      tone: chance === 0 ? 'bad' : chance != null && chance < 100 ? 'warn' : 'info',
      text: player.news.trim(),
    });
  }

  /* Selected but not playing is different from injured, and the model is slow
     to notice it — worth flagging in words rather than leaving to a number. */
  const mins = player.parts?.expMins;
  if (!player.news && Number.isFinite(mins) && mins > 0 && mins < 45) {
    out.push({
      source: SOURCE.MODEL,
      tone: 'warn',
      text: `expected around ${Math.round(mins)} minutes — not a certain starter`,
    });
  }

  /* Not injured, not dropped — simply hasn't appeared. The model is slow to
     react to this: a pooled prior of last season's minutes outweighs one
     unplayed gameweek, so a player with no minutes at all can still project
     like a starter. That gap is worth saying out loud rather than leaving in
     a number nobody can interrogate. */
  /* `seasonMinutes` where the row carries it — the Draft board sets `minutes`
     to last season's frozen total, so reading that field there would say a
     player who has not appeared has been playing all along. */
  const thisSeason = player.seasonMinutes ?? player.minutes;
  if (!player.news && Number.isFinite(thisSeason) && thisSeason === 0
      && Number.isFinite(player.parts?.expMins) && player.parts.expMins > 45) {
    out.push({
      source: SOURCE.MODEL,
      tone: 'warn',
      text: 'has not played a minute this season — this projection rests on last season',
    });
  }

  const fx = fixturePhrase(player, fixtures, teams, fromEvent, horizon);
  if (fx) out.push({ source: SOURCE.MODEL, tone: fx.tone, text: fx.text });

  /* Set-piece duty moves a projection more than almost anything else at this
     price, and it is a fact rather than an estimate. */
  if (player.penalties_order === 1) {
    out.push({ source: SOURCE.FPL, tone: 'good', text: 'first-choice penalty taker' });
  }
  if (player.direct_freekicks_order === 1) {
    out.push({ source: SOURCE.FPL, tone: 'good', text: 'takes direct free-kicks' });
  }

  /* Anything hand-written wins the last word, and says when it was written —
     a note with no date is worse than no note. */
  const m = manual?.[player.id] || manual?.[player.code];
  if (m?.text) out.push({ source: SOURCE.MANUAL, tone: m.tone || 'info', text: m.text, date: m.date || null });

  return out;
}

/**
 * Why one player should replace another, in a sentence built from real numbers.
 *
 * Deliberately concrete. "Justin is in better form" is unfalsifiable filler;
 * "projects 4.2 more over 5 gameweeks and has three kind fixtures" can be
 * checked against the page it sits on.
 */
export function justifyMove(out, inc, { fixtures, teams, fromEvent = 1, horizon = 5 } = {}) {
  const bits = [];
  const gain = (inc.proj ?? 0) - (out.proj ?? 0);
  if (Number.isFinite(gain) && Math.abs(gain) >= 0.05) {
    bits.push(`projects ${gain > 0 ? '+' : ''}${gain.toFixed(1)} over ${horizon} gameweek${horizon === 1 ? '' : 's'}`);
  }

  if (out.news?.trim()) bits.push(`${out.web_name} is flagged — ${out.news.trim().toLowerCase()}`);

  const outFx = fixturePhrase(out, fixtures, teams, fromEvent, horizon);
  const incFx = fixturePhrase(inc, fixtures, teams, fromEvent, horizon);
  if (outFx?.tone === 'bad') bits.push(`${out.web_name} has ${outFx.text}`);
  if (incFx?.tone === 'good') bits.push(`${inc.web_name} has ${incFx.text}`);

  const outMins = out.parts?.expMins;
  const incMins = inc.parts?.expMins;
  if (Number.isFinite(outMins) && Number.isFinite(incMins) && incMins - outMins > 15) {
    bits.push(`and is more likely to start (${Math.round(incMins)} minutes against ${Math.round(outMins)})`);
  }

  if (inc.penalties_order === 1 && out.penalties_order !== 1) bits.push('and takes the penalties');

  if (!bits.length) return `${inc.web_name} projects slightly higher; nothing else separates them.`;
  const s = bits.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}
