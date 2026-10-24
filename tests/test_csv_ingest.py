import csv
import tempfile
import unittest
from pathlib import Path

from mlbb_draft_finder.ingest import import_csv_files
from mlbb_draft_finder.repository import Catalog


class CsvIngestTests(unittest.TestCase):
    def test_manual_csv_import_and_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            heroes = root / "heroes.csv"
            drafts = root / "drafts.csv"
            with heroes.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(["slug", "name", "roles", "aliases"])
                for slug in ("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"):
                    writer.writerow([slug, slug.upper(), "", ""])
            with drafts.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(["match_id", "source", "source_url", "tournament", "date", "patch", "team_a", "team_b", "game_number", "order_available", "action_order", "phase", "team", "hero"])
                for order, (team, heroes_for_team) in enumerate((("team_a", "abcde"), ("team_b", "fghij")), 1):
                    for hero in heroes_for_team:
                        writer.writerow(["m1", "manual", "https://example.test/m1", "Test Cup", "2025-01-01", "1.0", "A", "B", 1, "true", order, "pick", team, hero])
            catalog = Catalog()
            try:
                result = import_csv_files(catalog, heroes, drafts)
                self.assertEqual(result["matches_added"], 1)
                self.assertEqual(len(catalog.matches()[0].picks("team_a")), 5)
            finally:
                catalog.close()

    def test_unknown_hero_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "heroes.csv").write_text("slug,name,roles,aliases\na,A,,\n", encoding="utf-8")
            rows = ["match_id,source,source_url,tournament,date,patch,team_a,team_b,game_number,order_available,action_order,phase,team,hero"]
            for order in range(1, 6):
                rows.append(f"m1,manual,https://example.test/m1,Cup,2025-01-01,1,A,B,1,true,{order},pick,team_a,a")
            for order in range(6, 11):
                rows.append(f"m1,manual,https://example.test/m1,Cup,2025-01-01,1,A,B,1,true,{order},pick,team_b,missing")
            (root / "drafts.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unknown hero slug missing"):
                import_csv_files(Catalog(), root / "heroes.csv", root / "drafts.csv")
