from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from mlbb_draft_finder.api import serve  # noqa: E402
from mlbb_draft_finder.ingest import import_captured_snapshot, import_csv_files, import_json_file  # noqa: E402
from mlbb_draft_finder.repository import Catalog  # noqa: E402


db_path = Path("data/catalog.sqlite3")
db_path.parent.mkdir(parents=True, exist_ok=True)
catalog = Catalog(db_path)
if not catalog.matches():
    raw_heroes = ROOT / "data/raw/mlbbdex_heroes.json"
    manual_drafts = ROOT / "data/manual/drafts.csv"
    if len(manual_drafts.read_text(encoding="utf-8").splitlines()) > 1:
        import_csv_files(catalog, ROOT / "data/manual/heroes.csv", manual_drafts)
    elif raw_heroes.exists():
        raw_snapshots = sorted((ROOT / "data/raw").glob("mlbbdex_*_latest.json"))
        # These three older MLBBDex Analytics batches have internally
        # consistent team/event data. Its MSC 2026 export and several other
        # selectors are quarantined because they reuse unrelated teams despite
        # the tournament label.
        approved_analytics = {
            "mlbbanalytics_m5_world_championship_playoffs.json",
            "mlbbanalytics_m6_world_championship_playoffs.json",
            "mlbbanalytics_msc_2024_playoffs.json",
        }
        analytics_snapshots = [
            path for path in sorted((ROOT / "data/raw").glob("mlbbanalytics_*_playoffs.json"))
            if path.name in approved_analytics
        ]
        if raw_snapshots or analytics_snapshots:
            for raw_snapshot in [*raw_snapshots, *analytics_snapshots]:
                import_captured_snapshot(catalog, raw_snapshot, raw_heroes)
        else:
            import_json_file(catalog, ROOT / "data/sample_catalog.json", "sample")
    else:
        import_json_file(catalog, ROOT / "data/sample_catalog.json", "sample")
serve(catalog, host="0.0.0.0", port=int(__import__("os").environ.get("PORT", "8080")))
