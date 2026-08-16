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

**Supabase is not needed.** The only mutable state is the user's own squad, which lives in `localStorage`. Worth adding only if several people need their own saved squads on one instance.

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
npm run seed  # synthetic data, no network
npm run refresh   # real fetch (needs network)
npm run serve     # http://localhost:8080
node scripts/build-pages.mjs   # regenerate HTML shells
```

## Data sources

- **FPL API** (unofficial, public, no auth): `bootstrap-static`, `fixtures`, `event/{gw}/live`, `entry/{id}/...`, `leagues-classic/{id}/standings`, `team/set-piece-notes`. Prices are tenths (`now_cost: 60` = £6.0m). `selected_by_percent` is already a percentage. Season xG totals are **strings**, per-90s are **numbers** — coerce both.
- **ESPN** `eng.1`: scoreboard, standings (note: `/apis/v2/`, not `/apis/site/v2/`), news. No FPL prices or points — fixtures and live scores only.

## Still to verify / do

1. **Live endpoints were unverifiable pre-season** — `event/{gw}/live`, fixture `stats[]`, `entry/{id}/picks` all return empty until GW1. Parsers read keys dynamically rather than assuming a fixed set, but check the dashboard against the official site on the first live gameweek.
2. **`bootstrap-static` currently holds 2025/26 totals.** FPL usually zeroes these at the GW1 deadline (21 Aug). Right prior to project from now, but it is not this season's form.
3. **`data/manual/season-notes.json` needs a pass after 1 September** — the window closes then and several entries are still labelled rumour (Barcola to Liverpool, Gakpo to Spurs, Grealish to Everton).
4. Recalibrate the bonus component once real BPS data accumulates.
5. Not yet pushed to GitHub — see MIGRATE.md.

## Season context worth remembering

- BPS rebalanced; defensive contribution thresholds **unchanged** (10 DEF / 12 MID+FWD, capped at 2/match)
- Chips: two sets of four, no Assistant Manager. BB and TC playable in GW1; WC and FH start GW2
- Free transfers bank to 5. Prices move at 00:00 UK, max £0.3m per gameweek
- Scores finalise 09:00 the day after the last match, not an hour after the whistle
- Salah left Liverpool on a free; Ekitiké out until 2027; no winger signed
- Buendía inherits every Villa set-piece duty after Rogers, Tielemans and Digne left
