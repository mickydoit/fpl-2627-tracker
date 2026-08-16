# Moving this to Claude Code

You're on macOS in a terminal. About ten minutes end to end.

## 1. Install Claude Code

```bash
brew install --cask claude-code
claude --version
```

Homebrew doesn't auto-update — run `brew upgrade claude-code` occasionally. If you'd rather have background updates, use the native installer instead: `curl -fsSL https://claude.ai/install.sh | bash`.

Needs a Pro, Max, Team or Enterprise plan. The free Claude.ai tier doesn't include Claude Code.

## 2. Unpack the project

```bash
cd ~/Projects            # or wherever you keep code
unzip ~/Downloads/fpl-2627-tracker.zip
cd fpl-tracker
git log --oneline        # three commits already here
```

The git history is committed, so there's nothing to stage.

## 3. Check it still runs

```bash
npm test
```

52 checks, about 3 seconds, no network needed. If that passes, everything survived the move.

## 4. Start Claude Code

```bash
claude
```

First run opens a browser to log in. It picks up `CLAUDE.md` automatically — that file has the full project context, the architecture constraints, and the two optimiser bugs not to reintroduce.

## 5. Connect Figma

```bash
claude plugin install figma@claude-plugins-official
```

Restart Claude Code, then `/plugin` → **Installed** tab → select **figma** → authorise in the browser. Run `/plugin` again to confirm it shows connected.

That's the remote server and it's the one to use. There's also a desktop server (`claude mcp add --transport http figma-desktop http://127.0.0.1:3845/mcp`) that requires the Figma desktop app open in Dev Mode with the server toggled on in the right sidebar — only worth it if your org blocks plugins.

Your file for reference:

```
figma.com/design/BkGUtiiNDfyw1IiSEqn3qD/WC-Draft?node-id=82-138
```

Node `82:138` is the stats screen, `11:18` the ladder, `184:29` the fixture card. All three are cited in `CLAUDE.md`.

## 6. GitHub

For creating the repo and pushing, **the `gh` CLI is simpler and more reliable than the MCP server** — it handles auth, repo creation and push in three commands:

```bash
brew install gh
gh auth login            # choose HTTPS, authenticate in browser
gh repo create fpl-2627-tracker --public --source=. --push
```

That creates the repo and pushes in one go. Then:

- **Settings → Pages → Source: GitHub Actions** (not "deploy from a branch" — the included `pages.yml` does the deploy and the branch option will fight it)
- **Settings → Actions → General → Workflow permissions → Read and write** (the refresh job commits data back; it fails without this)
- **Settings → Secrets and variables → Actions → Variables → New repository variable**: `FPL_ENTRY_ID` = your team id, the number in `fantasy.premierleague.com/entry/`**`1234567`**`/event/1`
- **Actions → Refresh FPL data → Run workflow** for the first real pull

Add the GitHub MCP server too if you want Claude reading issues and reviewing PRs conversationally — it's genuinely better for that than shelling out to `gh`:

```bash
claude mcp add --transport http github https://api.githubcopilot.com/mcp/ \
  --header "Authorization: Bearer YOUR_GITHUB_PAT"
```

Fine-grained token from [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens), scoped to this repo. `claude mcp add` doesn't validate credentials, so check `/mcp` shows `connected` rather than `failed`.

## 7. First prompt

Once the repo is up and the workflow has run once, something like:

> Read CLAUDE.md. The refresh workflow has run, so `data/` now has real FPL data instead of the synthetic seed. Run `npm test`, then `node scripts/derive.mjs` and show me the suggested squad. Sanity-check a few projections against real player prices — I want to know if the model is producing anything daft before I trust it for GW1.

That's the highest-value first task: the model has only ever seen synthetic data, so its first contact with real prices and real xG is where any calibration problem will show up.

## What changes now that you're local

- **Figma** — Claude can read your design nodes directly, so "make the transfers page match node X" works.
- **GitHub** — real write access. Push, branch, open PRs, read Actions logs when the workflow fails.
- **The FPL and ESPN APIs are reachable.** They were blocked in the cloud sandbox, which is why the seed data exists at all. `npm run refresh` will now do a real fetch locally.
- **You can run the site properly**: `npm run serve` → http://localhost:8080.
