from __future__ import annotations

import argparse
import json

from .api import serve
from .ingest import import_csv_files, import_json_file
from .repository import Catalog


def main() -> None:
    parser = argparse.ArgumentParser(description="MLBB professional draft finder backend")
    parser.add_argument("--db", default="data/catalog.sqlite3")
    sub = parser.add_subparsers(dest="command", required=True)
    imp = sub.add_parser("import-json", help="import a normalized source export")
    imp.add_argument("path")
    imp.add_argument("--source", default="import")
    csv_imp = sub.add_parser("import-csv", help="import manually curated hero and draft CSV files")
    csv_imp.add_argument("--heroes", required=True)
    csv_imp.add_argument("--drafts", required=True)
    run = sub.add_parser("serve", help="serve the JSON API")
    run.add_argument("--host", default="0.0.0.0")
    run.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    catalog = Catalog(args.db)
    try:
        if args.command == "import-json":
            print(json.dumps(import_json_file(catalog, args.path, args.source), indent=2))
        elif args.command == "import-csv":
            print(json.dumps(import_csv_files(catalog, args.heroes, args.drafts), indent=2))
        else:
            serve(catalog, args.host, args.port)
    finally:
        catalog.close()


if __name__ == "__main__":
    main()
