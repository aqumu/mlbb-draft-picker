import unittest

from mlbb_draft_finder.matcher import diagnose, find_candidates
from mlbb_draft_finder.models import DraftAction, DraftState, Hero, MatchDraft, PlayerPool
from mlbb_draft_finder.repository import Catalog
from mlbb_draft_finder.suggest import suggest

NAMES = ["a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3", "b4", "b5", "c1", "c2", "c3", "c4", "c5", "x1", "x2"]
A, B, C = NAMES[0:5], NAMES[5:10], NAMES[10:15]


def game(game_id, date, team_a, team_b, picks_a, picks_b, winner, side_a=None, side_b=None, bans_a=(), bans_b=()):
    actions = [DraftAction("pick", "team_a", h) for h in picks_a] + [DraftAction("pick", "team_b", h) for h in picks_b]
    actions += [DraftAction("ban", "team_a", h) for h in bans_a] + [DraftAction("ban", "team_b", h) for h in bans_b]
    return MatchDraft(game_id, "test", None, "Cup", date, None, team_a, team_b, 1, actions, False,
                      winner=winner, team_a_side=side_a, team_b_side=side_b)


class DraftLogicTests(unittest.TestCase):
    def setUp(self):
        self.catalog = Catalog()
        self.catalog.add_heroes([Hero(name, name) for name in NAMES])
        # Comp A is played three times (2 wins); Beta plays comp B once. g1 has no sides recorded.
        self.catalog.add_match(game("g1", "2026-05-01", "Alpha", "Beta", A, B, "Alpha"))
        self.catalog.add_match(game("g2", "2026-06-01", "Alpha", "Gamma", A, C, "Gamma", "blue side", "red side", bans_a=["x1"], bans_b=["x1", "x2"]))
        self.catalog.add_match(game("g3", "2026-07-01", "Delta", "Gamma", A, C, "Delta", "red side", "blue side", bans_a=["x1"], bans_b=["x1"]))

    def tearDown(self):
        self.catalog.close()

    def test_unknown_side_games_are_not_dropped(self):
        result = find_candidates(self.catalog, DraftState(our_picks=("b1",), our_side="blue side"))
        self.assertEqual([c.match_id for c in result], ["g1"])

    def test_side_is_a_ranking_nudge(self):
        catalog = Catalog()
        catalog.add_heroes([Hero(name, name) for name in NAMES])
        catalog.add_match(game("s1", "2026-06-01", "Alpha", "Gamma", A, C, None, "blue side", "red side"))
        catalog.add_match(game("s2", "2026-06-01", "Delta", "Gamma", B, C, None, "red side", "blue side"))
        blue = find_candidates(catalog, DraftState(our_side="blue side"))
        red = find_candidates(catalog, DraftState(our_side="red side"))
        self.assertEqual([len(blue), len(red)], [3, 3])  # nothing is filtered out
        self.assertEqual({blue[0].match_id, red[0].match_id}, {"s1", "s2"})
        self.assertEqual(blue[0].metadata["matched_team_side"], "blue side")
        self.assertEqual(red[0].metadata["matched_team_side"], "red side")
        catalog.close()

    def test_identical_compositions_are_grouped_with_a_record(self):
        result = find_candidates(self.catalog, DraftState(our_picks=("a1",)))
        self.assertEqual(len(result), 1)
        self.assertEqual({k: result[0].record[k] for k in ("games", "wins", "losses")}, {"games": 3, "wins": 2, "losses": 1})
        self.assertEqual(len(result[0].similar_games), 2)

    def test_recent_games_represent_the_group(self):
        self.catalog.add_match(game("old", "2023-12-01", "Epsilon", "Beta", A, B, "Epsilon"))
        result = find_candidates(self.catalog, DraftState(our_picks=("a1",)))
        self.assertEqual(result[0].record["games"], 4)
        self.assertNotEqual(result[0].match_id, "old")

    def test_enemy_overlap_prefers_similar_opponents(self):
        result = find_candidates(self.catalog, DraftState(our_picks=("a1",), enemy_picks=("b1",)))
        self.assertEqual(result[0].match_id, "g1")

    def test_diagnose_names_the_blocking_constraint(self):
        state = DraftState(our_picks=("a1",), bans=("a2",))
        self.assertEqual(find_candidates(self.catalog, state), [])
        blockers = diagnose(self.catalog, state)
        ban = next(item for item in blockers if item["constraint"] == "ban")
        self.assertEqual((ban["hero"], ban["compositions_if_lifted"]), ("a2", 1))

    def test_wildcard_never_outranks_a_listed_hero(self):
        listed = tuple(PlayerPool(f"p{i}", mastery={h: 1}) for i, h in enumerate(A))
        wild = tuple(PlayerPool(f"p{i}") for i in range(5))
        fit_listed = find_candidates(self.catalog, DraftState(our_picks=("a1",), player_pools=listed))[0].roster_fit
        fit_wild = find_candidates(self.catalog, DraftState(our_picks=("a1",), player_pools=wild))[0].roster_fit
        self.assertIsNone(fit_wild)  # an all-wildcard roster carries no roster information
        self.assertGreaterEqual(fit_listed, 0.45)


class SuggestionTests(unittest.TestCase):
    def setUp(self):
        self.catalog = Catalog()
        self.catalog.add_heroes([Hero(name, name) for name in NAMES])
        self.catalog.add_match(game("g1", "2026-06-01", "Alpha", "Gamma", A, C, "Alpha", bans_a=["x1"], bans_b=["x1"]))
        self.catalog.add_match(game("g2", "2026-06-02", "Alpha", "Gamma", A, C, "Alpha", bans_a=["x1"], bans_b=["x1", "x2"]))
        self.lanes = {"a1": ["exp", "jungle"], "a2": ["mid"], "c1": ["roam", "mid", "exp"], "x1": ["gold"], "x2": ["gold"]}

    def tearDown(self):
        self.catalog.close()

    def test_flex_picks_need_multiple_lanes(self):
        flex = [item["hero"] for item in suggest(self.catalog, DraftState(), self.lanes)["flex_picks"]]
        self.assertEqual(set(flex), {"a1", "c1"})
        self.assertEqual(flex[0], "c1")  # three lanes beats two at equal pick rate

    def test_most_banned_hero_leads_ban_suggestions(self):
        bans = suggest(self.catalog, DraftState(), self.lanes)["bans"]
        self.assertEqual(bans[0]["hero"], "x1")

    def test_heroes_our_team_masters_drop_down_the_ban_list(self):
        pools = (PlayerPool("p0", mastery={"x1": 3}),)
        bans = suggest(self.catalog, DraftState(player_pools=pools), self.lanes, limit=20)["bans"]
        order = [item["hero"] for item in bans]
        self.assertGreater(order.index("x1"), 0)
        x1 = next(item for item in bans if item["hero"] == "x1")
        self.assertTrue(any("plays it" in reason for reason in x1["reasons"]))

    def test_taken_heroes_are_not_suggested(self):
        result = suggest(self.catalog, DraftState(bans=("x1",), our_picks=("a1",)), self.lanes)
        shown = {item["hero"] for item in result["bans"] + result["flex_picks"]}
        self.assertFalse(shown & {"x1", "a1"})


if __name__ == "__main__":
    unittest.main()
