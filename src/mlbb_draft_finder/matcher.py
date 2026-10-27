from __future__ import annotations

from dataclasses import dataclass

from .models import DraftState, MatchDraft, PlayerPool
from .repository import Catalog


def _normalise_side(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip().lower().replace(" side", "")


@dataclass(frozen=True)
class Candidate:
    match_id: str
    side: str
    composition: tuple[str, ...]
    locked_picks: tuple[str, ...]
    remaining_picks: tuple[str, ...]
    opponent_composition: tuple[str, ...]
    bans: tuple[str, ...]
    metadata: dict
    score: float | None
    score_details: tuple[dict, ...]
    score_summary: dict | None = None
    rejection_reasons: tuple[str, ...] = ()
    our_bans: tuple[str, ...] = ()
    opponent_bans: tuple[str, ...] = ()
    draft_actions: tuple[dict, ...] = ()

    def as_dict(self) -> dict:
        return {"match_id": self.match_id, "side": self.side, "composition": list(self.composition),
                "locked_picks": list(self.locked_picks), "remaining_picks": list(self.remaining_picks),
                "opponent_composition": list(self.opponent_composition), "bans": list(self.bans),
                "our_picks": list(self.composition), "opponent_picks": list(self.opponent_composition),
                "our_bans": list(self.our_bans), "opponent_bans": list(self.opponent_bans),
                "our_draft": {"team": self.metadata.get("matched_team"), "side": self.metadata.get("matched_team_side"),
                              "picks": list(self.composition), "bans": list(self.our_bans)},
                "opponent_draft": {"team": self.metadata.get("opponent_team"), "side": self.metadata.get("opponent_team_side"),
                                   "picks": list(self.opponent_composition), "bans": list(self.opponent_bans)},
                "draft_actions": list(self.draft_actions),
                "metadata": self.metadata, "score": self.score,
                "score_summary": self.score_summary, "score_details": list(self.score_details),
                "rejection_reasons": list(self.rejection_reasons)}


def _assignable(composition: tuple[str, ...], heroes: dict, state: DraftState) -> bool:
    pools = state.player_pools
    if not pools:
        return True
    if len(pools) < len(composition):
        return False
    edges: dict[str, list[str]] = {}
    for hero in composition:
        locked = state.locked_players.get(hero)
        edges[hero] = []
        for pool in pools:
            if locked and locked != pool.player:
                continue
            if hero in pool.cannot_play:
                continue
            if pool.can_play and hero not in pool.can_play:
                continue
            if pool.roles and not set(pool.roles).intersection(heroes.get(hero).roles):
                continue
            edges[hero].append(pool.player)
        if not edges[hero]:
            return False
    assigned: dict[str, str] = {}
    def visit(hero: str, seen: set[str]) -> bool:
        for player in edges[hero]:
            if player in seen:
                continue
            seen.add(player)
            if player not in assigned or visit(assigned[player], seen):
                assigned[player] = hero
                return True
        return False
    return all(visit(hero, set()) for hero in composition)


def _score(catalog: Catalog, remaining: tuple[str, ...], enemy: tuple[str, ...]) -> tuple[float | None, tuple[dict, ...], dict]:
    if not remaining or not enemy:
        return None, (), {"coverage": 0.0, "known_pairs": 0, "possible_pairs": len(remaining) * len(enemy), "sample_games": 0}
    details = []
    hero_scores = []
    prior = 20
    known_pairs = 0
    sample_games = 0
    possible_pairs = len(remaining) * len(enemy)
    for hero in remaining:
        match_scores = []
        samples = 0
        known = 0
        for opponent in enemy:
            wins, games = catalog.matchup(hero, opponent)
            if games:
                posterior = (wins + prior * 0.5) / (games + prior)
                confidence = games / (games + prior)
                value = 0.5 + confidence * (posterior - 0.5)
                match_scores.append(value)
                samples += games
                known += 1
        if match_scores:
            value = sum(match_scores) / len(match_scores)
            hero_scores.append(value)
            known_pairs += known
            sample_games += samples
            details.append({"hero": hero, "estimated_win_rate": round(value, 4), "enemy_data_points": samples,
                            "coverage": round(len(match_scores) / len(enemy), 4), "known_matchups": known,
                            "possible_matchups": len(enemy)})
        else:
            details.append({"hero": hero, "estimated_win_rate": None, "enemy_data_points": 0, "coverage": 0.0,
                            "known_matchups": 0, "possible_matchups": len(enemy)})
    if not hero_scores:
        return None, tuple(details), {"coverage": 0.0, "known_pairs": 0, "possible_pairs": possible_pairs, "sample_games": 0}
    raw_fit = sum(hero_scores) / len(hero_scores)
    coverage = known_pairs / possible_pairs if possible_pairs else 0.0
    # Missing matchup rows are treated as neutral evidence instead of silently
    # letting one favorable row determine the whole recommendation.
    score = 0.5 + coverage * (raw_fit - 0.5)
    return score, tuple(details), {"coverage": round(coverage, 4), "known_pairs": known_pairs,
                                   "possible_pairs": possible_pairs, "sample_games": sample_games,
                                   "raw_fit": round(raw_fit, 4)}


def find_candidates(catalog: Catalog, state: DraftState, limit: int = 50) -> list[Candidate]:
    heroes = catalog.heroes()
    ours, enemies, bans, excluded = set(state.our_picks), set(state.enemy_picks), set(state.bans), set(state.excluded_heroes)
    output: list[Candidate] = []
    for match in catalog.matches():
        match_bans = tuple(match.bans())
        for side, opponent_side in (("team_a", "team_b"), ("team_b", "team_a")):
            matched_side = match.team_a_side if side == "team_a" else match.team_b_side
            if state.our_side and _normalise_side(matched_side) != _normalise_side(state.our_side):
                continue
            composition = tuple(match.picks(side))
            opponent = tuple(match.picks(opponent_side))
            our_bans = tuple(match.bans_for(side))
            opponent_bans = tuple(match.bans_for(opponent_side))
            if len(composition) != 5 or len(set(composition)) != 5:
                continue
            if not ours.issubset(composition) or enemies.intersection(composition) or excluded.intersection(composition):
                continue
            if bans.intersection(composition) or state.available_heroes is not None and not set(composition).issubset(state.available_heroes):
                continue
            if not _assignable(composition, heroes, state):
                continue
            remaining = tuple(h for h in composition if h not in ours)
            score, details, score_summary = _score(catalog, remaining, tuple(state.enemy_picks))
            draft_actions = tuple({"phase": action.phase, "team": action.team, "hero": action.hero,
                                   "order": action.order} for action in match.actions)
            output.append(Candidate(match.id, side, composition, tuple(state.our_picks), remaining, opponent, match_bans,
                                    {"source": match.source, "source_url": match.source_url, "tournament": match.tournament,
                                     "date": match.date, "patch": match.patch, "stage": match.stage, "series": match.series,
                                     "duration": match.duration, "winner": match.winner, "team_a": match.team_a, "team_b": match.team_b,
                                     "team_a_side": match.team_a_side, "team_b_side": match.team_b_side, "game_number": match.game_number,
                                     "order_available": match.order_available, "bans_known": match.bans_known, "source_refs": match.source_refs,
                                     "matched_team": match.team_a if side == "team_a" else match.team_b,
                                     "opponent_team": match.team_b if side == "team_a" else match.team_a,
                                     "matched_team_side": match.team_a_side if side == "team_a" else match.team_b_side,
                                     "opponent_team_side": match.team_b_side if side == "team_a" else match.team_a_side,
                                     "score_coverage": score_summary["coverage"], "score_sample_games": score_summary["sample_games"]},
                                    score, details, score_summary, (), our_bans, opponent_bans, draft_actions))
    output.sort(key=lambda c: (c.score is not None, c.score or 0.0,
                               c.score_summary.get("coverage", 0.0) if c.score_summary else 0.0), reverse=True)
    return output[:limit]
