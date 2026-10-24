# Curated draft data

This folder is the manual ingestion boundary for human-reviewed professional
drafts. It is intentionally committed to Git so every data change has a review
history and Render can redeploy it automatically.

1. Add or update hero rows in `heroes.csv`. Use the canonical lowercase slug used
   by the API; separate roles and aliases with `|`.
2. Add one row per ban or pick in `drafts.csv`. Repeat the match metadata on every
   row. Use `action_order` when the source gives an order; leave it blank when it
   does not and set `order_available` to `false`.
3. Keep a direct `source_url` for every match. Do not copy prose or images from a
   source; record only the structured draft facts and attribution link.
4. Validate and import locally:

   ```powershell
   $env:PYTHONPATH = "src"
   python -m mlbb_draft_finder.cli --db data/catalog.sqlite3 import-csv `
     --heroes data/manual/heroes.csv --drafts data/manual/drafts.csv
   ```

   Commit the reviewed CSV change. Render will rebuild the catalog on deploy.

The importer rejects unknown heroes, inconsistent metadata, duplicate picks,
missing source links, and matches without exactly five picks per team.
