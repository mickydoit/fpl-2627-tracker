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

/* Below this many minutes a game a player is not finishing matches, which is
   the thing a manager needs told. A player averaging 72 does not need a note. */
const ROTATION_MPG = 60;

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
     to notice it — worth flagging in words rather than leaving to a number.

     This reads `observedMpg`, NOT `expMins`. `expMins` is shrunk toward the
     positional prior until 450 minutes of evidence exist, so two gameweeks
     into a season every ninety-minute starter still sits near 42 and a
     threshold of "under 45 means rotation risk" fired on fourteen players out
     of fifteen — Haaland and Fernandes among them, both of whom had played
     every minute. A note that fires on the whole squad is not a note. The
     rotation question is about football that happened, so it is answered from
     minutes actually played. */
  const mpg = player.parts?.observedMpg;
  if (!player.news && Number.isFinite(mpg) && mpg > 0 && mpg < ROTATION_MPG) {
    out.push({
      source: SOURCE.MODEL,
      tone: 'warn',
      text: `averaging ${Math.round(mpg)} minutes a game — rotation risk`,
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
export function justifyMove(out, inc, { fixtures, teams, fromEvent = 1, horizon = 5, horizonLabel = null } = {}) {
  const bits = [];
  const gain = (inc.proj ?? 0) - (out.proj ?? 0);
  /* The window named here must be the window `proj` was computed over. Draft
     board rows carry a rest-of-season projection, so labelling their difference
     "over 5 gameweeks" attaches the wrong period to a real number — which is
     worse than saying nothing. Callers whose rows are not an N-gameweek total
     pass their own label. */
  const period = horizonLabel || `over ${horizon} gameweek${horizon === 1 ? '' : 's'}`;
  if (Number.isFinite(gain) && Math.abs(gain) >= 0.05) {
    bits.push(`projects ${gain > 0 ? '+' : ''}${gain.toFixed(1)} ${period}`);
  }

  if (out.news?.trim()) bits.push(`${out.web_name} is flagged — ${out.news.trim().toLowerCase()}`);

  const outFx = fixturePhrase(out, fixtures, teams, fromEvent, horizon);
  const incFx = fixturePhrase(inc, fixtures, teams, fromEvent, horizon);
  if (outFx?.tone === 'bad') bits.push(`${out.web_name} has ${outFx.text}`);
  if (incFx?.tone === 'good') bits.push(`${inc.web_name} has ${incFx.text}`);

  const outMins = out.parts?.expMins;
  const incMins = inc.parts?.expMins;
  if (Number.isFinite(outMins) && Number.isFinite(incMins) && incMins - outMins > 15) {
    /* Named, because without a subject this read "…; is more likely to start"
       and the reader had to guess which of the two players it meant.
       `expMins` rather than observed minutes on purpose: both sides are shrunk
       toward their positional prior by the same rule, so the comparison
       survives it, and it is far steadier than a one-match average. */
    bits.push(`${inc.web_name} projects more minutes (${Math.round(incMins)} against ${Math.round(outMins)})`);
  }

  if (inc.penalties_order === 1 && out.penalties_order !== 1) bits.push('takes the penalties');

  if (!bits.length) return `${inc.web_name} projects slightly higher; nothing else separates them.`;
  const s = bits.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}


/**
 * The transfer table: out, in, and why.
 *
 * Shared by both products because the shape of the decision is the same even
 * though the mechanics are not. Classic passes price (it has a budget); Draft
 * passes none (it has no money, and inventing one would be describing a
 * mechanic that game does not have). Everything else is identical.
 *
 * @param {Array} moves    [{out, in, gain}]
 * @param {(p:object)=>Array} statsFor  the boxes under each tile
 */
/**
 * @param {(move, i) => string|null} verdictFor
 *   The classifier's word on each row. A list of five options where only the
 *   first is worth making looks like five endorsements unless every row says
 *   what it is, so anything showing more than the best move should pass this.
 */
export function transferRows(moves, { teams, fixtures, fromEvent, horizon, horizonLabel = null, statsFor, onPlayer, playerTile, el, verdictFor = null }) {
  const strong = (v) => /STRONG|GOOD/.test(v || '');
  return el('div', { class: 'ttable' }, moves.map((m, i) => {
    const v = verdictFor ? verdictFor(m, i) : null;
    return el('div', { class: `trow ${v && !strong(v) ? 'marginal' : ''}` },
      el('span', { class: 'tn' }, String(i + 1)),
      el('span', { class: 'tout' }, playerTile(m.out, { teams, stats: statsFor(m.out, 'out'), onPlayer })),
      el('span', { class: 'tarrow' }, '\u2192'),
      el('span', { class: 'tin' }, playerTile(m.in, { teams, stats: statsFor(m.in, 'in'), onPlayer })),
      el('span', { class: 'twhy' },
        v ? el('span', { class: `rowverdict ${strong(v) ? 'go' : 'hold'}` }, v) : null,
        justifyMove(m.out, m.in, { fixtures, teams, fromEvent, horizon, horizonLabel })));
  }));
}


/**
 * The notes panel: one row per player, and the row says WHO.
 *
 * The name used to be rendered and then hidden in CSS (`.noterow .nn` was
 * `display: none`), which left a column of unattributed sentences — three
 * consecutive lines reading "averaging 40 minutes a game" with no way to tell
 * which three players they were about. That is what made the panel feel
 * random: a note is a fact about somebody, and without the somebody it is
 * just a mood.
 *
 * Built as a bordered list because that is what the fixture list and the
 * transfer table are. It looked isolated partly because it was the only thing
 * on the page with no container at all.
 *
 * @param {{p: object, notes: object[]}[]} rows
 */
export function noteRows(rows, { teams, onPlayer, el }) {
  const label = (n) => (n.source === SOURCE.FPL ? 'FPL' : n.source === SOURCE.MANUAL ? 'NOTE' : 'MODEL');
  return el('div', { class: 'notelist' }, rows.map(({ p, notes }) =>
    el('div', { class: 'noterow', onClick: () => onPlayer?.(p) },
      el('span', { class: 'nn' },
        el('span', { class: 'nname' }, p.web_name),
        el('span', { class: 'nteam' }, teams?.[p.team]?.short_name || '')),
      el('span', { class: 'nb' }, notes.map((n) =>
        el('span', { class: `note-line ${n.tone}` },
          el('span', { class: `note-src ${n.source}` }, label(n)),
          n.text,
          n.date ? el('i', { class: 'ndate' }, ` (${n.date})`) : null))))));
}
