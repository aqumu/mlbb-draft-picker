from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from mlbb_draft_finder.api import serve  # noqa: E402
from mlbb_draft_finder.ingest import import_json_file  # noqa: E402
from mlbb_draft_finder.repository import Catalog  # noqa: E402


db_path = Path("data/catalog.sqlite3")
db_path.parent.mkdir(parents=True, exist_ok=True)
catalog = Catalog(db_path)
if not catalog.matches():
    import_json_file(catalog, ROOT / "data/sample_catalog.json", "sample")
serve(catalog, host="0.0.0.0", port=int(__import__("os").environ.get("PORT", "8080")))
