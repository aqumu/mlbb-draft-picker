# Browser-captured source snapshots

These files are research snapshots captured from the public pages with the
Playwriter browser workflow. They are not loaded by the running API until they
are reviewed and converted into the curated catalog.

## MLBBDex

`mlbbdex_msc_2026_latest.json` contains the 36 games currently exposed in the
MSC 2026 page's “latest drafts” section. It includes both teams' picks and bans,
side, date, duration, winner, and source references. The page says the detailed
section covers the last ten matches/series, not the complete 92-game event.

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
