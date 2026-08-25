/**
 * The two structured clauses FPL's `news` field actually contains, and nothing
 * else.
 *
 * Audited across all 610 players: after the dash, `news` uses a fixed and very
 * small vocabulary — "Unknown return date" (47), "NN% chance of playing" (24),
 * "Has joined <club> ..." (38), "Expected back <D Mon>" (7) and "Suspended
 * until <D Mon>" (1). Only the last two carry information the model does not
 * already have from `status` and `chance_of_playing_next_round`.
 *
 * So this parses those two and refuses everything else. It does NOT attempt to
 * read injury prose, and must never be extended to: the moment a parser starts
 * interpreting "back in training" or "assessed late", it is guessing about a
 * player's fitness from a sentence a journalist wrote, and a wrong guess here
 * silently rewrites a projection. No NLP, no LLM, no diagnosis lookup.
 *
 * The two clauses are NOT the same kind of statement, and the caller is told
 * which it got:
 *
 *   suspension       deterministic. A ban ends on a known date; before it the
 *                    player cannot be picked, after it he simply can.
 *   expected-return  an estimate. FPL's best guess at a comeback date, useful
 *                    structured evidence and treated provisionally, but it is
 *                    not a promise and is labelled so downstream and in the
 *                    archive can tell the two apart later.
 */

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Days in a month, so 31 Feb is rejected rather than rolled into March. */
const daysIn = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

const CLAUSE = /(Expected back|Suspended until)\s+(\d{1,2})\s+([A-Za-z]{3,9})\b/i;

/**
 * @param {object} player  needs `news` and `news_added`
 * @returns {{kind: 'suspension'|'expected-return', boundary: number, text: string}|null}
 *          `boundary` is a UTC timestamp: the first instant the player might
 *          play again. null means "nothing parsable" — never a guess.
 */
export function parseReturnBoundary(player) {
  const news = typeof player?.news === 'string' ? player.news.trim() : '';
  if (!news) return null;
  const m = news.match(CLAUSE);
  if (!m) return null;

  const month = MONTHS[m[3].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  if (!Number.isInteger(day) || day < 1) return null;

  /* Anchored to when FPL published the note, not to now. A date has no year in
     this format, so the anchor is what decides whether "10 Jan" means next
     January or last one — and reading it against today would silently change
     the answer as the season moves past it. Without an anchor there is no
     defensible year, so the clause is refused rather than guessed at. */
  const anchor = player?.news_added ? Date.parse(player.news_added) : NaN;
  if (!Number.isFinite(anchor)) return null;

  const anchorYear = new Date(anchor).getUTCFullYear();
  if (day > daysIn(anchorYear, month)) return null;      // 31 Sep and friends

  let boundary = Date.UTC(anchorYear, month, day);
  if (boundary < anchor) {
    /* The note was published after this date in the calendar year, so it means
       the same day next year — "Expected back 10 Jan" written in December. */
    const nextYear = anchorYear + 1;
    if (day > daysIn(nextYear, month)) return null;
    boundary = Date.UTC(nextYear, month, day);
  }

  return {
    kind: /suspended/i.test(m[1]) ? 'suspension' : 'expected-return',
    boundary,
    text: news,
  };
}
