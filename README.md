# MLBB Draft Finder

This repository contains the backend, a minimal test frontend, and offline
source snapshots for a tool that finds **real professional MLBB compositions**
which remain feasible during a live draft. It filters historical five-hero
sides against locked picks, enemy picks, bans, hero availability, and
per-player hero pools. An optional score uses only supplied matchup samples and
reports its coverage and sample size.

The stable integration point is the JSON API:

```text
GET  /v1/health
GET  /v1/heroes
GET  /v1/matches
GET  /v1/relationships?hero=fredrinn
POST /v1/candidates
```

Example request:

```json
{
  "our_picks": ["fredrinn"],
  "enemy_picks": ["atlas"],
  "bans": [],
  "player_pools": [
    {"player": "exp", "heroes": {"fredrinn": "master", "lapu-lapu": "average"}},
    {"player": "jungle", "heroes": {"joy": 3, "fanny": 1}},
    {"player": "flex", "heroes": {}}
  ],
  "limit": 20
}
```

`GET /v1/heroes` includes each hero's `lanes` (primary first), read from [`data/hero_lanes.json`](data/hero_lanes.json): the MLBBDex lane list with manual corrections for the current meta. Edit that file to change a hero's lanes; the API reads it at startup.

Lanes: a player may instead give `lanes`, a map from lane (`exp`, `mid`, `jungle`, `gold`, `roam`) to that lane's hero pool in the same format, e.g. `{"player": "p0", "lanes": {"jungle": {"fanny": "master"}, "gold": {"beatrix": 2}}}`. Each player fills one lane per draft and no two players share a lane. A lane with an empty pool means "plays this lane, any hero"; assignments report the lane used.

Player pools: `heroes` maps each hero a player can play to a mastery level (`learning`/`1`, `average`/`2`, `master`/`3`). A draft is only returned if its five heroes can be given to five different players who play them, so a hero nobody plays rules the draft out. A player with an empty `heroes` object is a flexible placeholder who can play anything at a neutral weight. `can_play`, `cannot_play` and `roles` still work. When any player lists heroes, each candidate carries `roster_fit` (0-1, the best assignment's mean mastery weight: learning 0.45, average 0.75, master 1.0, flexible 0.6), the winning `assignment` (hero, player, mastery) and `rank_score`. Results are ranked by `rank_score`, which is `roster_fit` adjusted by the matchup `score`.

`POST /v1/candidates` returns complete historical compositions, the remaining picks, the full opposing draft (`opponent_draft` with picks and bans), both sides' bans, the captured action list, tournament/team/game/patch metadata, source links, and transparent `score_details`. `score` is an advisory matchup fit: missing hero-versus-enemy rows shrink the result toward 50%, and `score_summary` reports known rows, coverage, and sample games. A null score means there is no matchup data for the remaining heroes against the visible enemy picks. The request may include `excluded_heroes` to remove heroes from the matched side while simulating a team pool, and `our_side` (`blue side` or `red side`) to restrict matches to that side. `GET /v1/matches` exposes the same two-sided draft under `teams.team_a` and `teams.team_b`, including picks, bans, and action order when the source provides it.

## Run locally

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
python -m mlbb_draft_finder.cli --db data/catalog.sqlite3 import-json data/sample_catalog.json --source sample
python -m mlbb_draft_finder.cli --db data/catalog.sqlite3 import-mlbbdex `
  --snapshot data/raw/mlbbdex_msc_2026_latest.json --heroes data/raw/mlbbdex_heroes.json
python -m mlbb_draft_finder.cli --db data/catalog.sqlite3 serve --port 8080
```

The sample catalog is a shape/behavior fixture, not a claim that it is a complete production dataset. Production ingestion should use approved structured exports, retain source URLs, and run deduplication through the canonical match key.

## Source ingestion

`mlbb_draft_finder.ingest` accepts a normalized JSON export with `heroes`, `matches`, and optional `matchup_stats`. `LiquipediaAdapter` and `MLBBDexAdapter` provide cached JSON client boundaries for approved endpoints or exports. The Liquipedia adapter does not scrape generated HTML. MLBBDex's documented public API currently covers hero/item/patch/ranking data; it does not document a pro-match draft endpoint, so its adapter requires an explicitly supplied draft export path. Configure an identifying User-Agent, respect the source's rate limits, cache responses, and keep attribution in `source_refs`.

The checked-in snapshots currently seed 240 deduplicated games across MSC 2026,
M7, MPL PH S18, MPL ID S18, MPL MY S18, M6, M5, and MSC 2024. Relationship
aggregates are kept in separate per-source, per-tournament buckets.

### Manual catalog workflow

When a source does not offer usable API access, add human-reviewed records to [`data/manual/heroes.csv`](data/manual/heroes.csv) and [`data/manual/drafts.csv`](data/manual/drafts.csv). The draft file has one row per ban or pick, so it can preserve the original order when the page shows it. Run `import-csv` locally to validate the rows before committing them. Render automatically rebuilds the service from the committed catalog; no source request happens at runtime. See [`data/manual/README.md`](data/manual/README.md) for the exact workflow.

### Browser-captured source data

The Playwriter capture scripts in `scripts/extract_mlb*.js` save public MLBBDex and MLBB Analytics snapshots under [`data/raw`](data/raw). `scripts/extract_mlbbdex_tournament.js` and `scripts/extract_mlbbanalytics_tournament.js` are reusable page captures; set their tournament URL and Liquipedia attribution link before running them. The Render startup script loads all MLBBDex snapshots and only the reviewed MLBB Analytics batches; mismatched Analytics exports remain quarantined. See [`data/raw/README.md`](data/raw/README.md).

Liquipedia's API terms require attribution and prohibit automated access to generated HTML. The MediaWiki API limit is one request per two seconds with a project-specific User-Agent; the separate LiquipediaDB API requires approved access and is limited to 60 requests per hour. These constraints are why ingestion is an offline, cached job rather than a request-time dependency.

## Free deployment

`render.yaml` is ready for a Render free web service. Connect this repository in Render and choose **Blueprint**, or create a Python web service with:

[Deploy this repository to Render](https://render.com/deploy?repo=https://github.com/aqumu/mlbb-draft-picker)

```text
Build:  pip install .
Start:  python scripts/start_server.py
```

Render's free filesystem is ephemeral, so the service reloads the checked-in
manual catalog when it has rows; otherwise it loads every checked-in MLBBDex
snapshot (or the demonstration catalog if no snapshot exists) after a restart.
The service listens on Render's `PORT` environment variable and exposes
`/v1/health` for the health check.

The minimal test frontend is deployed separately at [mlbb-draft-finder-web.onrender.com](https://mlbb-draft-finder-web.onrender.com). It calls the API at `https://mlbb-draft-finder-api.onrender.com` and uses MLBBDex hero icon URLs. Its source lives in [`web`](web).
