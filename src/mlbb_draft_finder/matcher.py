from __future__ import annotations

from dataclasses import dataclass

from .models import DraftState, MatchDraft, PlayerPool
from .repository import Catalog


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
    rejection_reasons: tuple[str, ...] = ()

    def as_dict(self) -> dict:
        return {"match_id": self.match_id, "side": self.side, "composition": list(self.composition),
                "locked_picks": list(self.locked_picks), "remaining_picks": list(self.remaining_picks),
                "opponent_composition": list(self.opponent_composition), "bans": list(self.bans),
                "metadata": self.metadata, "score": self.score,
                "score_details": list(self.score_details), "rejection_reasons": list(self.rejection_reasons)}


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


def _score(catalog: Catalog, remaining: tuple[str, ...], enemy: tuple[str, ...]) -> tuple[float | None, tuple[dict, ...]]:
    if not remaining or not enemy:
        return None, ()
    details = []
    hero_scores = []
    prior = 20
    for hero in remaining:
        match_scores = []
        samples = 0
        for opponent in enemy:
            wins, games = catalog.matchup(hero, opponent)
            if games:
                posterior = (wins + prior * 0.5) / (games + prior)
                confidence = min(1.0, games / prior)
                value = 0.5 + confidence * (posterior - 0.5)
                match_scores.append(value)
                samples += games
        if match_scores:
            value = sum(match_scores) / len(match_scores)
            hero_scores.append(value)
            details.append({"hero": hero, "estimated_win_rate": round(value, 4), "enemy_data_points": samples,
                            "coverage": round(len(match_scores) / len(enemy), 4)})
        else:
            details.append({"hero": hero, "estimated_win_rate": None, "enemy_data_points": 0, "coverage": 0.0})
    if not hero_scores:
        return None, tuple(details)
    return sum(hero_scores) / len(hero_scores), tuple(details)


def find_candidates(catalog: Catalog, state: DraftState, limit: int = 50) -> list[Candidate]:
    heroes = catalog.heroes()
    ours, enemies, bans = set(state.our_picks), set(state.enemy_picks), set(state.bans)
    output: list[Candidate] = []
    for match in catalog.matches():
        match_bans = tuple(match.bans())
        for side, opponent_side in (("team_a", "team_b"), ("team_b", "team_a")):
            composition = tuple(match.picks(side))
            opponent = tuple(match.picks(opponent_side))
            if len(composition) != 5 or len(set(composition)) != 5:
                continue
            if not ours.issubset(composition) or enemies.intersection(composition):
                continue
            if bans.intersection(composition) or state.available_heroes is not None and not set(composition).issubset(state.available_heroes):
                continue
            if not _assignable(composition, heroes, state):
                continue
            remaining = tuple(h for h in composition if h not in ours)
            score, details = _score(catalog, remaining, tuple(state.enemy_picks))
            output.append(Candidate(match.id, side, composition, tuple(state.our_picks), remaining, opponent, match_bans,
                                    {"source": match.source, "source_url": match.source_url, "tournament": match.tournament,
                                     "date": match.date, "patch": match.patch, "team_a": match.team_a, "team_b": match.team_b,
                                     "game_number": match.game_number, "order_available": match.order_available, "source_refs": match.source_refs}, score, details))
    output.sort(key=lambda c: (c.score is not None, c.score or 0.0), reverse=True)
    return output[:limit]
