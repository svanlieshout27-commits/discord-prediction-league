# Discord Prediction League

A weekly Premier League prediction coupon with a live, self-updating leaderboard.

**Files**
- `index.html` — the leaderboard page people visit.
- `refresh.mjs` — fetches real results + everyone's predictions and updates the page.
- `config.json` — which gameweeks to show, and the link to each week's predictions.
- `data.json` — the current data (auto-written by the refresh).
- `.github/workflows/refresh.yml` — runs the refresh automatically every day.

---

## Step 1 — Put it online with Vercel (no coding)

1. Go to <https://github.com/new> and create a repo (e.g. **discord-prediction-league**).
2. Click **“uploading an existing file”** and drag in everything from this folder
   (keep the `.github` folder — that's what makes it auto-update).
3. Click **Commit changes**.
4. Go to <https://vercel.com/new>, **Import** that repo, and click **Deploy**.
5. You get a link like **`discord-prediction-league.vercel.app`** — share it with your players.

The page is live immediately (showing demo data until real entries come in).

## Step 2 — Turn on the automatic weekly updates

1. **Add your API token as a secret:** in your GitHub repo, go to
   **Settings → Secrets and variables → Actions → New repository secret**.
   Name it exactly `FOOTBALL_DATA_TOKEN` and paste your football-data.org token as the value.
2. **Add your predictions link:** open `config.json`, and replace `PASTE_YOUR_PUBLISHED_CSV_LINK_HERE`
   with the published-to-web CSV link of your GW1 responses sheet.
   Add more `{ ... }` blocks for later gameweeks as the season goes on.
3. That's it. Every day the leaderboard fetches the latest results, scores everyone, and updates itself.
   (You can also trigger it manually: repo → **Actions → Refresh leaderboard → Run workflow**.)

---

### Quick alternative: Netlify Drop (no account, but not self-updating)
Rename `index.html` and drag it onto <https://app.netlify.com/drop> for an instant link.
