from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from mlbb_draft_finder.api import serve  # noqa: E402
from mlbb_draft_finder.ingest import import_csv_files, import_json_file, import_mlbbdex_snapshot  # noqa: E402
from mlbb_draft_finder.repository import Catalog  # noqa: E402


db_path = Path("data/catalog.sqlite3")
db_path.parent.mkdir(parents=True, exist_ok=True)
catalog = Catalog(db_path)
if not catalog.matches():
    raw_mlbbdex = ROOT / "data/raw/mlbbdex_msc_2026_latest.json"
    raw_heroes = ROOT / "data/raw/mlbbdex_heroes.json"
    manual_drafts = ROOT / "data/manual/drafts.csv"
    if len(manual_drafts.read_text(encoding="utf-8").splitlines()) > 1:
        import_csv_files(catalog, ROOT / "data/manual/heroes.csv", manual_drafts)
    elif raw_mlbbdex.exists() and raw_heroes.exists():
        import_mlbbdex_snapshot(catalog, raw_mlbbdex, raw_heroes)
    else:
        import_json_file(catalog, ROOT / "data/sample_catalog.json", "sample")
serve(catalog, host="0.0.0.0", port=int(__import__("os").environ.get("PORT", "8080")))
