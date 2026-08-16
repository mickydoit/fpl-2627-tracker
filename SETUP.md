# Getting this onto your GitHub

Four steps, about three minutes.

## 1. Create the repo

Either in the browser at [github.com/new](https://github.com/new) — name it `fpl-2627-tracker`, **Public**, and do **not** tick "Add a README" — or with the CLI:

```bash
gh repo create fpl-2627-tracker --public
```

## 2. Push

Unzip the bundle, then from inside the `fpl-tracker` folder:

```bash
git remote add origin https://github.com/mickydoit/fpl-2627-tracker.git
git push -u origin main
```

The git history is already committed, so there's nothing to stage. If you'd rather use a different repo name, just change it in the URL above.

## 3. Turn on Pages

**Settings → Pages → Source: GitHub Actions.**

Not "Deploy from a branch" — the included `pages.yml` workflow does the deploy, and picking the branch option instead will fight with it.

Your site will be at `https://mickydoit.github.io/fpl-2627-tracker/`.

## 4. Point it at your FPL team

**Settings → Secrets and variables → Actions → Variables tab → New repository variable:**

| Name | Value |
|---|---|
| `FPL_ENTRY_ID` | your team id |
| `FPL_LEAGUE_IDS` | optional, comma-separated mini-league ids |

To find your entry id: log in to [fantasy.premierleague.com](https://fantasy.premierleague.com), go to **Points**, and read the number out of the URL — `fantasy.premierleague.com/entry/`**`1234567`**`/event/1`.

These are **variables**, not secrets. Your entry id is public data, and the workflow only ever reads.

Skip this step and everything still works except the live "My Team" panel and mini-league tracking — the optimiser, transfer suggester and player explorer don't need it.

## 5. Pull the real data

**Actions → Refresh FPL data → Run workflow.**

First run takes about a minute. After that it runs itself every 30 minutes.

Until you run it, the site shows synthetic seed data behind a gold banner, so you can click through everything immediately. The banner disappears once real data lands.

---

## If the Actions tab shows nothing

New repos sometimes need workflows enabled: **Actions → I understand my workflows, go ahead and enable them.**

## If the refresh workflow fails on push

It needs write permission to commit the data back. **Settings → Actions → General → Workflow permissions → Read and write permissions.**

## Running it locally

```bash
npm run test      # generates seed data, runs 52 checks on the model and optimiser
npm run seed      # synthetic data only, no network needed
npm run refresh   # the real fetch (needs network access to the FPL and ESPN APIs)
npm run serve     # http://localhost:8080
```

---

## Two things to do before the 1 September deadline

1. **`data/manual/season-notes.json`** holds everything no API exposes — manager tactical profiles, penalty and set-piece takers, injuries, transfer rumours. The refresh workflow never touches it, so edit it freely. It's current as of 16 August; the window closes 1 September, and several of the entries in there are still labelled as rumour.

2. **Check the dashboard against the official site on the first live gameweek.** The live-scoring endpoints return empty until GW1 kicks off, so their exact shape couldn't be verified pre-season. The parsers read keys dynamically rather than assuming a fixed set, but it's worth one look at real numbers.
