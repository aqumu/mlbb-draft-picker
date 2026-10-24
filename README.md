# MLBB Draft Finder backend

This repository contains the backend for a tool that finds **real professional MLBB compositions** which remain feasible during a live draft. It filters historical five-hero sides against locked picks, enemy picks, bans, hero availability, and per-player hero pools. An optional score uses only supplied matchup samples and reports its coverage and sample size.

The frontend is intentionally outside this repository. The stable integration point is the JSON API:

```text
GET  /v1/health
GET  /v1/heroes
GET  /v1/matches
POST /v1/candidates
```

Example request:

```json
{
  "our_picks": ["fredrinn"],
  "enemy_picks": ["atlas"],
  "bans": [],
  "player_pools": [
    {"player": "exp", "roles": ["fighter"], "can_play": ["fredrinn"]}
  ],
  "limit": 20
}
```

`POST /v1/candidates` returns complete historical compositions, the remaining picks, original opponent composition, bans, tournament/team/game/patch metadata, source links, and transparent `score_details`. A null score means there is no matchup data for the remaining heroes against the visible enemy picks; it is not an invented estimate.

## Run locally

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
python -m mlbb_draft_finder.cli --db data/catalog.sqlite3 import-json data/sample_catalog.json --source sample
python -m mlbb_draft_finder.cli --db data/catalog.sqlite3 serve --port 8080
```

The sample catalog is a shape/behavior fixture, not a claim that it is a complete production dataset. Production ingestion should use approved structured exports, retain source URLs, and run deduplication through the canonical match key.

## Source ingestion

`mlbb_draft_finder.ingest` accepts a normalized JSON export with `heroes`, `matches`, and optional `matchup_stats`. `LiquipediaAdapter` and `MLBBDexAdapter` provide cached JSON client boundaries for approved endpoints or exports. The Liquipedia adapter does not scrape generated HTML. MLBBDex's documented public API currently covers hero/item/patch/ranking data; it does not document a pro-match draft endpoint, so its adapter requires an explicitly supplied draft export path. Configure an identifying User-Agent, respect the source's rate limits, cache responses, and keep attribution in `source_refs`.

### Manual catalog workflow

When a source does not offer usable API access, add human-reviewed records to [`data/manual/heroes.csv`](data/manual/heroes.csv) and [`data/manual/drafts.csv`](data/manual/drafts.csv). The draft file has one row per ban or pick, so it can preserve the original order when the page shows it. Run `import-csv` locally to validate the rows before committing them. Render automatically rebuilds the service from the committed catalog; no source request happens at runtime. See [`data/manual/README.md`](data/manual/README.md) for the exact workflow.

Liquipedia's API terms require attribution and prohibit automated access to generated HTML. The MediaWiki API limit is one request per two seconds with a project-specific User-Agent; the separate LiquipediaDB API requires approved access and is limited to 60 requests per hour. These constraints are why ingestion is an offline, cached job rather than a request-time dependency.

## Free deployment

`render.yaml` is ready for a Render free web service. Connect this repository in Render and choose **Blueprint**, or create a Python web service with:

[Deploy this repository to Render](https://render.com/deploy?repo=https://github.com/aqumu/mlbb-draft-picker)

```text
Build:  pip install .
Start:  python scripts/start_server.py
```

Render's free filesystem is ephemeral, so the service reloads the checked-in manual catalog when it has rows, otherwise the demonstration catalog, after a restart. A production catalog should move to a persistent database and a scheduled ingestion job. The service listens on Render's `PORT` environment variable and exposes `/v1/health` for the health check.
