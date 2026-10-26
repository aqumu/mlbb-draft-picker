# Browser-captured source snapshots

These files are snapshots captured from the public pages with the Playwriter
browser workflow. MLBBDex batches are normalized and loaded as the seed for
the running API. The MLBB Analytics snapshot remains quarantined until its
event discrepancy is resolved.

## MLBBDex

The following MLBBDex files contain the games currently exposed in each
tournament page's "latest drafts" section:

* `mlbbdex_msc_2026_latest.json` — 36 games
* `mlbbdex_mpl_ph_season_18_latest.json` — 26 games
* `mlbbdex_mpl_id_season_18_latest.json` — 26 games
* `mlbbdex_mpl_my_season_18_latest.json` — 24 games
* `mlbbdex_m7_world_championship_latest.json` — 42 games

Each record includes both teams' picks and bans, side, date, stage, series,
duration, winner, patch range, and source references. MLBBDex describes this section as the
last ten matches/series, so these are recent, curated batches rather than the
complete tournament histories. One MPL ID game exposes four bans for one team;
it is retained with `bans_known=false` instead of inventing a fifth ban.

## MLBB Analytics

`mlbbanalytics_msc_2026_playoffs.json` contains 18 game logs exposed after
opening the site's playoff breakdown and expanding all games. It is quarantined
for cross-checking: its four displayed series use Legion Esports, Niightmare
Esports, Brute Force, and IHC Esports, while the MLBBDex snapshot for the same
MSC 2026 event uses a different set of teams. Do not merge these records until
the discrepancy is resolved against the linked Liquipedia pages.

Both snapshots retain the page URL and Liquipedia attribution link. The raw
files intentionally preserve what each page displayed rather than silently
choosing one source when they disagree.
