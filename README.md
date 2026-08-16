# FPL 26/27 — Draft & Transfer Lab

A Fantasy Premier League tracker, squad optimiser and transfer suggester for the 2026/27 season. Static site on GitHub Pages, data pulled by a scheduled GitHub Action. No server, no database, no API keys.

Same visual language as [World-Cup-Draft](https://github.com/mickydoit/World-Cup-Draft) — pitch green and gold, mobile-first.

---

## What it does

| Page | What it's for |
|---|---|
| **Dashboard** | Deadline countdown, your live gameweek score, live match scores, price movers, best-value picks |
| **Squad** | Solves for the best legal 15 within £100.0m, with lock/exclude controls |
| **Transfers** | Ranks every legal transfer by projected points gained, net of any hit |
| **Players** | Sortable, filterable explorer with xGI/90, DefCon/90, fixture ticker and a per-player projection breakdown |
| **Market** | New managers and their systems, signings, departures, penalty and set-piece takers, injuries, live rumours |
| **Rules** | The 2026/27 scoring rules, read live from the API, plus what changed and why it matters |

---

## Setup

### 1. Create the repo

```bash
gh repo create fpl-2627-tracker --public --source=. --push
```

Or create it in the GitHub UI and push this folder to `main`.

### 2. Turn on Pages

**Settings → Pages → Source: GitHub Actions.** The `pages.yml` workflow deploys on every push to `main`.

### 3. Point it at your FPL team (optional but recommended)

**Settings → Secrets and variables → Actions → Variables → New repository variable:**

| Name | Value |
|---|---|
| `FPL_ENTRY_ID` | your FPL team id — the number in `fantasy.premierleague.com/entry/**1234567**/event/1` |
| `FPL_LEAGUE_IDS` | optional, comma-separated mini-league ids. Left blank, it tracks every private league you're in. |

These are *variables*, not secrets — your entry id is public data.

### 4. Run the data workflow once

**Actions → Refresh FPL data → Run workflow.** It runs every 30 minutes after that.

Until then the site shows synthetic seed data behind a gold "seed data" banner, so you can click through the whole thing before the first real fetch.

---

## Architecture, and why it's built this way

```
GitHub Actions (every 30 min)
    ├── fantasy.premierleague.com/api  →  players, prices, fixtures, live scores, your team
    └── site.api.espn.com/.../eng.1    →  live match scores, league table, news
                    ↓
            commits data/*.json
                    ↓
    GitHub Pages serves the static site
                    ↓
    Browser fetches same-origin JSON, runs the projection model client-side
```

**The FPL API cannot be called from the browser.** It sends no `Access-Control-Allow-Origin` header and sets `Cross-Origin-Resource-Policy: same-origin`, so a page on `github.io` is blocked outright — there is no header workaround, and `mode: 'no-cors'` doesn't help either. Fetching server-side in Actions and committing the result solves this without a proxy, a Worker or a database. It also means:

- **Price history for free.** Every price change is a git commit, so `data/price-history.json` accumulates a full season of movement.
- **No runtime dependency on either API.** If FPL 503s at the deadline — which it reliably does — the site keeps serving the last good snapshot.
- **ESPN's Akamai layer never sees your visitors.** `site.api.espn.com` 403s unrecognised user-agents; the runner presents a browser UA once, rather than every visitor's browser gambling on it.

**Supabase isn't needed.** The only mutable state is your own squad, which lives in `localStorage`, and price history, which git handles better than a database would. Worth adding only if you later want several people using the same instance with their own saved squads.

### Guards

- The fetch aborts rather than committing a partial `bootstrap-static` — a truncated payload would silently poison every projection, and yesterday's snapshot beats that.
- Files are only written when their content actually changes, hashed first. `bootstrap-static` is ~1.2 MB and mutates constantly; committing every run would bloat the repo without adding information.
- `derive.mjs` re-runs the model server-side and fails the job if the optimiser produces an illegal squad, so a model regression breaks the build instead of quietly shipping bad advice.

---

## The projection model

Every projection is a sum of components that each map onto a real scoring rule, and every player ships with a visible breakdown. The point is that you can see *why* a player is rated, not just that he is.

| Component | How it's estimated |
|---|---|
| Appearance | Expected minutes from minutes per team game → P(plays) and P(reaches 60) |
| Attacking | xG/90 and xA/90 × the position's goal value, adjusted for fixture difficulty and home advantage |
| Clean sheet | Team xGC per match, opponent-adjusted, through a Poisson zero probability |
| Goals conceded | −xGC/2 for keepers and defenders |
| Saves | saves/90 ÷ 3 |
| Defensive contribution | The API's per-90 rate directly; where missing, raw actions through a Poisson P(≥ 10 or 12) |
| Bonus | Logistic map from BPS/90 |
| Cards | Yellow card rate |

Players without enough minutes on record are blended toward a price-based prior, so a new signing from abroad isn't projected at zero — those are flagged in their breakdown as leaning on a prior.

**Known limitation:** the bonus component is calibrated on the old BPS. The 2026/27 rebalance removes the tackle penalty, moves CBI to 1 point per three, and restructures keeper saves — which downgrades stationary centre-backs and upgrades attacking full-backs and shot-stopping keepers. Treat early-season bonus estimates for those profiles with some caution until there's real data to recalibrate against.

### The optimiser

Choosing 15 players under a budget, a three-per-club cap and per-position quotas is a constrained knapsack — NP-hard, with no ILP solver available in the browser. It uses randomised greedy construction followed by steepest-ascent local search over single swaps, with multiple restarts and a fixed seed so the same inputs always give the same squad. In practice it converges on the same squads a proper solver finds, in well under a second.

Tunables are exposed in the UI: horizon, budget, risk aversion (how hard to avoid flagged players) and bench weight (whether to punt on bench fodder or build real cover).

---

## 2026/27 rule changes the model accounts for

- **BPS rebalanced** — tackle penalty removed, CBI now 1 point per three, keeper saves restructured (3 inside the box, 2 otherwise, +1 for a big chance, penalty save 7+1)
- **Defensive contribution unchanged** — 10 for defenders, 12 for midfielders and forwards, capped at 2 points per match. The predicted drop to 10 for midfielders did not happen
- **Chips: two sets of four**, no Assistant Manager. Bench Boost and Triple Captain are playable in GW1; Wildcard and Free Hit start in GW2
- **Free transfers bank to five**
- **Price changes at 00:00 UK**, max £0.3m movement per gameweek
- **Scores finalise at 09:00 the day after** the last match, not an hour after the whistle
- **Live ranks and projected bonus after 20 minutes**

Sources are linked in-app on the Rules and Market pages.

---

## Keeping the research current

`data/manual/season-notes.json` holds everything no API exposes — manager tactical profiles, penalty and set-piece takers, injury lists, transfer rumours. The refresh workflow never touches it, so edit it freely. It's the file to update after the 1 September deadline, and whenever a manager's system becomes clear.

Two things worth revisiting once the season is underway:

1. `bootstrap-static` currently carries **2025/26 season totals** — FPL usually zeroes these at the GW1 deadline. Until then, projections are built on last season's evidence, which is the right prior but is not this season's form.
2. The live endpoint shapes (`event/{gw}/live`, fixture `stats[]`, `entry/{id}/picks`) couldn't be verified pre-season because they return empty. The parsers read keys dynamically rather than assuming a fixed set, but check the dashboard against the official site on the first live gameweek.

---

## Local development

```bash
node scripts/make-sample.mjs   # synthetic data, no network needed
node scripts/derive.mjs        # run the model, print a suggested squad
npm run serve                  # http://localhost:8080
```

With network access, `npm run refresh` does the real fetch.

---

## Data sources

- **[Fantasy Premier League API](https://fantasy.premierleague.com/api/bootstrap-static/)** — players, prices, ownership, fixtures with difficulty, live scoring, your team, mini-leagues, official set-piece notes. Unofficial but public and stable; no auth needed for anything used here.
- **[ESPN](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard)** (`eng.1`) — live match scores, league table, news.
- **Hand-curated** — manager systems, set-piece duties, injuries and the transfer market, with sources linked per item.
