import unittest
from pathlib import Path

from mlbb_draft_finder.ingest import import_mlbbdex_snapshot
from mlbb_draft_finder.repository import Catalog


ROOT = Path(__file__).parents[1]


class MLBBDexImportTests(unittest.TestCase):
    def test_snapshot_normalizes_real_draft_batch_and_derives_relationships(self):
        catalog = Catalog()
        try:
            result = import_mlbbdex_snapshot(catalog, ROOT / "data/raw/mlbbdex_msc_2026_latest.json", ROOT / "data/raw/mlbbdex_heroes.json")
            self.assertEqual(result["matches_added"], 36)
            self.assertGreater(result["matchup_stats"], 0)
            self.assertGreater(result["synergy_stats"], 0)
            match = catalog.matches()[0]
            self.assertFalse(match.order_available)
            self.assertTrue(match.bans_known)
            self.assertIn(match.team_a_side, {"blue side", "red side"})
            self.assertEqual(len(match.picks("team_a")), 5)
            self.assertEqual(len(match.picks("team_b")), 5)
        finally:
            catalog.close()
