# FPL 26/27 — project memory

Context for anyone (human or Claude) picking this up. Written 16 Aug 2026, five days before the GW1 deadline.

## What this is

A Fantasy Premier League 2026/27 tracker, squad optimiser and transfer suggester. Static site on GitHub Pages, data pulled by a scheduled GitHub Action. No server, no database, no API keys.

Owner: Michael de Wet (`mickydoit` on GitHub). Design matches his LBH Draft app.

## The one constraint that shapes everything

**The FPL API cannot be called from a browser.** `fantasy.premierleague.com/api/*` sends no `Access-Control-Allow-Origin` header and sets `Cross-Origin-Resource-Policy: same-origin`. There is no header workaround and `mode: 'no-cors'` doesn't help — a page on `github.io` is blocked outright.

So: a GitHub Action fetches server-side every 30 minutes and commits JSON into `data/`. The browser only ever reads same-origin files. **Do not "improve" this by fetching the FPL API client-side — it will fail in production while appearing to work if you test against a local proxy.**

Three things fall out of it that are worth keeping:
- Price history is free — every change is a git commit (`data/price-history.json`).
- The site survives FPL 503s, which are reliable around deadlines.
- ESPN's Akamai layer never sees visitors (`site.api.espn.com` 403s unrecognised user-agents; the runner presents a browser UA once).

**Supabase holds the draft board and nothing else.** Applied 18 Aug 2026 to project `gwemacdcdpeuajhjhamc`: one `draft_state` table, one row id (`fpl-2627-draft`), RLS scoped to that id, a trigger that owns `updated_at` so the client cannot spoof which device is newer. `supabase/0001_draft_state.sql` is the source of truth — re-runnable, and it explains why each policy is shaped the way it is. The squad, and everything else, still lives in `localStorage`; `js/draft/sync.js` is a mirror that fails quietly, never a source of truth. Don't route tracker data through it.

## Layout

```
index/squad/transfers/players/market/rules.html   generated — see below
js/model.js        projection engine (browser + node)
js/optimiser.js    squad solver + transfer suggester
js/data.js         snapshot loading, localStorage
js/ui.js           DOM helpers
js/pages/*.js      one per page
scripts/fetch-all.mjs    the Action's fetch step
scripts/derive.mjs       re-runs the model server-side, fails the build on a bad squad
scripts/make-sample.mjs  synthetic seed data, no network
scripts/test.mjs         model + optimiser test suite
scripts/build-pages.mjs  generates the six HTML shells
data/manual/season-notes.json   hand-curated research; the workflow never touches it
```

**The HTML files are generated.** Edit `scripts/build-pages.mjs` and re-run it. Editing the six files by hand will be silently overwritten.

## Design

Ported from the WC Draft Figma: `figma.com/design/BkGUtiiNDfyw1IiSEqn3qD`, nodes `82:138` (stats), `11:18` (ladder), `184:29` (fixture card). Tokens are at the top of `css/base.css`.

- `#202123` ground, `#393939` cards on `#808080` hairlines, 12px radius, 18.5px pills
- Accents `#9fed00` lime / `#8bffec` cyan / `#f4ff7b` yellow
- Ladder rows: `#510e93` → `#8bffec`. Leader/captain: `#b4790a` → `#aaf9c7`
- **Each page owns an accent** via `data-accent` on `<body>` — the Figma's ladder screen is cyan, stats is lime

Two deliberate departures:

1. **Font.** The design uses *FONTSPRING DEMO – PODIUM Sharp 4.13*, a demo licence that can't ship in a public repo. **Anton** stands in. To swap: drop the webfont in `fonts/`, add an `@font-face`, change `--font-display`. Nothing else.
2. **Text flips across gradient rows.** The gradient runs dark purple → light cyan, so one text colour is unreadable at one end. Labels left are white, values right are dark ink — which is what the Figma ladder does. Don't "fix" this to a single colour.

Fonts are self-hosted in `fonts/` (~140KB woff2), not Google-linked. Logo and nav icons are the Figma file's own SVG exports.

## The projection model

Each component maps to a real 2026/27 scoring rule and every player carries a visible breakdown.

| Component | Estimated from |
|---|---|
| Appearance | minutes per team game → P(plays), P(60+) |
| Attacking | xG/90 and xA/90 × position goal value, fixture- and home-adjusted |
| Clean sheet | team xGC per match, opponent-adjusted, Poisson zero |
| Def. contribution | API per-90 rate; where missing, raw actions via Poisson P(≥10 or 12) |
| Bonus | logistic map from BPS/90 |

Players short on minutes blend toward a price-based prior, flagged as `isPrior` in the breakdown.

**Known calibration gap:** the bonus component is fitted on the *old* BPS. The 2026/27 rebalance (tackle penalty removed, CBI now 1 per 3, keeper saves restructured) downgrades stationary centre-backs and upgrades attacking full-backs and shot-stopping keepers. Recalibrate once a few gameweeks of real data exist. This is documented in the README and on the Rules page — don't quietly drop the caveat.

## The optimiser — two bugs already fixed, don't reintroduce

Choosing 15 under a budget, a 3-per-club cap and position quotas is a constrained knapsack. No ILP solver in the browser, so: randomised greedy → steepest-ascent local search → **paired swaps**, multi-restart, fixed seed.

1. **Single-swap search alone doesn't converge.** It can't escape a local optimum needing a downgrade to fund an upgrade. `bestPairSwap` exists for exactly this. Removing it silently costs points. Verified: at £0.0m bank the best remaining transfer is −0.018, i.e. nothing left.
2. **The greedy budget reserve must respect the 3-per-club cap.** Reserving against the globally cheapest player per position is wrong — greedy concentrates early picks in strong clubs, so the cheapest *reachable* keeper can cost far more than the cheapest keeper in the league. Under-reserving strands the solve with no legal candidate and returns null. `reserveFor()` filters by club availability. A single seed hid this for a while, which is why `scripts/test.mjs` ends with a 40-dataset stress test.

Always compare optimiser and transfer-search at the **same** bank. Giving the transfer search extra money finds "improvements" the optimiser was never allowed to make and says nothing about convergence.

## Commands

```bash
npm test      # seed data + full check suite. Run this after touching model.js or optimiser.js
              # NOTE: it runs make-sample first, which OVERWRITES data/ with synthetic
              # data. `git checkout -- data/` afterwards, or run npm run refresh.
npm run seed  # synthetic data, no network
npm run refresh   # real fetch (needs network)
npm run serve     # http://localhost:8080
node scripts/build-pages.mjs   # regenerate HTML shells
```

## Data sources

- **FPL API** (unofficial, public, no auth): `bootstrap-static`, `fixtures`, `event/{gw}/live`, `entry/{id}/...`, `leagues-classic/{id}/standings`, `team/set-piece-notes`. Prices are tenths (`now_cost: 60` = £6.0m). `selected_by_percent` is already a percentage. Season xG totals are **strings**, per-90s are **numbers** — coerce both.
- **ESPN** `eng.1`: scoreboard, standings (note: `/apis/v2/`, not `/apis/site/v2/`), news. No FPL prices or points — fixtures and live scores only.

## Data source semantics — check the field, don't infer it

The research rules below cover claims about the world. These cover claims about
the **API**, which is where this project actually goes wrong. Every entry here
was reported to the owner as fact and was wrong. A field name that reads like
plain English is not a definition.

**Before reporting anything derived from a payload, run the check.** Not after
he pushes back.

| Trap | What is actually true | Check |
|---|---|---|
| `fixture.finished` looks like "match over" | It is **not**. `finished_provisional: true` means played and **bonus already awarded** (3/2/1 in `stats[]`). `finished` only flips after FPL's final confirmation pass the morning after the last match of the gameweek. Bonus is live all season. | `jq '[.[]\|select(.event==1)\|{started,finished,finished_provisional}]' data/fixtures.json` |
| `is_next` means "the gameweek to project" | It flips to GW+1 **the moment the deadline passes**, while the current gameweek still has unplayed fixtures. Anything keying `fromEvent` off it silently drops the rest of the current gameweek. Fixtures spread Fri–Mon, so this is true most of every week. | compare `events[].is_current/is_next` against `fixtures` with `started=false` in that event |
| Draft and classic element ids are the same | **21 of 587 differ.** Tzolis is 554 in Draft and 557 in classic. Ownership, live points and the board must all be keyed in one space — see `js/prior.js` and `scripts/fetch-draft.mjs`. Join on `code`, which is stable across both games and across seasons. | `node -e` diff of `draft/players.json` ids vs `bootstrap.json` ids by `code` |
| `bootstrap-static` totals are this season | They are **last season until the GW1 deadline**, then zeroed and refilled. A payload with ~600 league-wide points is one gameweek, not a season. `data/draft/prior-2526.json` is the frozen copy and is the only surviving record. | `node -e 'const b=require("./data/bootstrap.json");console.log(b.elements.reduce((a,e)=>a+ +e.total_points,0))'` |
| Season xG totals are numbers | Totals in the `expected_*` family are **strings**; the `*_per_90` variants are numbers. Coerce both or `"0.00"` silently poisons the arithmetic. | `typeof` both before using either |
| `team/set-piece-notes` is the set-piece authority | Empty for all 20 clubs pre-season ("Check back for additional notes soon") and stays empty for weeks. The authority is `penalties_order` / `corners_and_indirect_freekicks_order` / `direct_freekicks_order` in `bootstrap-static`. | `node -e 'const s=require("./data/set-pieces.json");console.log(s.teams.filter(t=>t.notes?.some(n=>!/Check back/.test(n.info_message))).length)'` |
| A minutes threshold means the same before and after pooling | `js/prior.js` rebuilds `modelMinutes` onto a pooled basis, so a filter like `teamDefence()`'s `mins < 450` passes on a single match. Eligibility must use `evidenceMinutes` (actually observed), never `modelMinutes`. | see [[classic-model-needs-frozen-prior]] |

**Two rules that would have caught all of these:**

1. **A conclusion about a payload cites the field that proves it.** "Bonus is
   provisional" cited nothing. `finished_provisional: true` with `bonus: 3` in
   `stats[]` settles it in one command.
2. **When the owner questions a claim, re-derive it from the payload before
   defending it.** Every time this has happened, he was right.

## Research rules

Everything hand-curated — `data/manual/season-notes.json`, README claims, anything
reported to the owner as fact — gets verified before it is written down. This is not
generic caution; it has already gone wrong.

On 18 Aug 2026 a search for the Community Shield returned the headline *"Arsenal beat
Man City on penalties after a last-gasp equaliser"*. That was the **2023** final. The
2026 match was Arsenal 3-0 (Calafiori 1', Havertz 28', Ødegaard 48'). The wrong result
was committed to `season-notes.json` and reported to the owner, who caught it. Search
results carry no date unless you look for one.

1. **Date the source, not the claim.** An undated snippet about a recurring fixture —
   a Community Shield, a derby, an opening weekend — is worthless. Open the page and
   find the year, or use a URL that contains it.
2. **Prefer the primary source.** Results: thefa.com, the club sites, the Wikipedia
   match page. Squads, prices, injuries, set pieces: `bootstrap-static`, which is
   re-fetched every 30 minutes and settles most questions outright.
3. **Cross-check against the API before believing reporting.** If an article says a
   player has moved and `bootstrap-static` still registers him at the old club, the API
   wins — the transfer has not completed. That check caught all six open rumours.
4. **Aggregators and rumour sites are for transfer *status* only**, and the note must
   carry the date the status was true: "personal terms agreed as of 17 Aug", never
   "personal terms agreed".
5. **If it cannot be verified, write that down** instead of asserting it. A note saying
   "unconfirmed" costs nothing; a wrong note gets acted on.

## Still to verify / do

*Last reviewed 22 Aug 2026, during GW1.*

1. **Draft `replacementBasis` is set to the losing option for this league.**
   `scripts/test-draft.mjs` audits the config against a 64-draft head-to-head and
   fails: at six teams `demand` beats `starters` 46–0, about 41 pts per squad;
   the crossover is around ten teams, and the test hardcodes eight. Only feeds
   the live draft assistant (`js/pages/draft.js`), so it is dormant until the
   next draft — but it is the one failing check in the suite.
2. **Recalibrate the bonus component.** Still fitted on the old BPS. First real
   evidence has arrived: the draft suite's bonus-domination check was failing at
   a 0.39 share during GW1. Revisit once a few gameweeks exist.
3. **`data/manual/season-notes.json` needs a pass after 1 September** — the
   window closes then and five entries are still rumour (Barcola to Liverpool,
   Gakpo to Spurs, Grealish to Everton, Enzo to City, Lewis Hall to United).
4. **`lastSeasonWeight` in `js/prior.js` is 0.5 by judgement, not by fit.** It
   sets when this season overtakes last (around GW19). Worth fitting alongside
   the bonus recalibration.
5. **Check live scoring against the official site once GW1 completes.** The
   parsers are verified against the API — `data/live.json` and
   `data/draft/live.json` both matched `event/1/live` exactly, 0 disagreements
   across 604 rows on 22 Aug — but the last GW1 match is FUL-CHE on 24 Aug, and
   `finished` only flips the morning after. Confirm bonus and totals settle.

**Done, kept so it is not re-investigated:** the GW1 zeroing happened as expected
and `js/prior.js` now pools the frozen prior; the site is live on GitHub Pages at
`mickydoit.github.io/fpl-2627-tracker` (MIGRATE.md is historical).

## Season context worth remembering

- BPS rebalanced; defensive contribution thresholds **unchanged** (10 DEF / 12 MID+FWD, capped at 2/match)
- Chips: two sets of four, no Assistant Manager. BB and TC playable in GW1; WC and FH start GW2
- Free transfers bank to 5. Prices move at 00:00 UK, max £0.3m per gameweek
- Scores finalise 09:00 the day after the last match, not an hour after the whistle
- Salah left Liverpool on a free; Ekitiké out until 2027; no winger signed
- Buendía inherits Villa's penalties and direct free-kicks after Rogers, Tielemans and Digne left — but **not corners**: bootstrap-static lists Cash first and McGinn second there (checked 21 Aug 2026)
