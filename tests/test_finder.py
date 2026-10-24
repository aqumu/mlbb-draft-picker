import json
import tempfile
import unittest
from pathlib import Path

from mlbb_draft_finder.ingest import import_json_file
from mlbb_draft_finder.matcher import find_candidates
from mlbb_draft_finder.models import DraftState, PlayerPool
from mlbb_draft_finder.repository import Catalog


ROOT = Path(__file__).parents[1]


class FinderTests(unittest.TestCase):
    def setUp(self):
        self.catalog = Catalog()
        import_json_file(self.catalog, ROOT / "data/sample_catalog.json", "sample")

    def tearDown(self):
        self.catalog.close()

    def test_locked_pick_and_enemy_pick_filter(self):
        result = find_candidates(self.catalog, DraftState(our_picks=("fredrinn",), enemy_picks=("atlas", "kadita")))
        self.assertEqual([c.match_id for c in result], ["mpl-id-s10-g1"])

    def test_candidate_can_be_assigned_to_player_pools(self):
        pools = tuple(PlayerPool(p, (role,), frozenset(), frozenset()) for p, role in (
            ("exp", "fighter"), ("jungle", "assassin"), ("mid", "mage"), ("gold", "marksman"), ("roam", "support")))
        result = find_candidates(self.catalog, DraftState(our_picks=("fredrinn",), player_pools=pools))
        self.assertEqual([c.match_id for c in result], ["mpl-id-s10-g1"])

    def test_ban_makes_candidate_ineligible(self):
        result = find_candidates(self.catalog, DraftState(bans=("joy",)))
        self.assertFalse(any(c.match_id == "mpl-id-s10-g1" and c.side == "team_a" for c in result))

    def test_matchup_score_is_transparent(self):
        result = find_candidates(self.catalog, DraftState(our_picks=("fredrinn",), enemy_picks=("atlas",)))
        candidate = next(c for c in result if c.match_id == "mpl-id-s10-g1")
        self.assertIsNotNone(candidate.score)
        self.assertEqual(candidate.score_details[0]["hero"], "joy")

    def test_duplicate_match_keeps_second_source_reference(self):
        payload = {
            "heroes": [],
            "matches": [{
                "id": "same-game-from-other-source", "source": "other", "source_url": "https://example.test/game",
                "tournament": "MPL Indonesia Season 10", "date": "2022-10-23", "team_a": "ONIC Esports",
                "team_b": "RRQ Hoshi", "game_number": 1, "actions": []
            }]
        }
        from mlbb_draft_finder.ingest import import_payload
        import_payload(self.catalog, payload)
        match = next(m for m in self.catalog.matches() if m.id == "mpl-id-s10-g1")
        self.assertIn("other", [ref["source"] for ref in match.source_refs])


if __name__ == "__main__":
    unittest.main()
