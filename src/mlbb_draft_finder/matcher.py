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
    roster_fit: float | None = None
    assignment: tuple[dict, ...] = ()
    rank_score: float | None = None

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
                "roster_fit": self.roster_fit, "assignment": list(self.assignment), "rank_score": self.rank_score,
                "metadata": self.metadata, "score": self.score,
                "score_summary": self.score_summary, "score_details": list(self.score_details),
                "rejection_reasons": list(self.rejection_reasons)}


# Weight of a hero in a player's pool: mastery level 1/2/3 and, for players
# without mastery data, plain can_play entries and wildcard players.
MASTERY_WEIGHT = {1: 0.45, 2: 0.75, 3: 1.0}
CAN_PLAY_WEIGHT = MASTERY_WEIGHT[2]
WILDCARD_WEIGHT = 0.6


def _weight(pool: PlayerPool, hero: str) -> float | None:
    """How well this player fits the hero, or None if they cannot play it."""
    if hero in pool.cannot_play:
        return None
    if hero in pool.mastery:
        return MASTERY_WEIGHT.get(pool.mastery[hero], CAN_PLAY_WEIGHT)
    if hero in pool.can_play:
        return CAN_PLAY_WEIGHT
    return None if pool.restricted else WILDCARD_WEIGHT


def _assign(composition: tuple[str, ...], heroes: dict, state: DraftState) -> tuple[float, dict[str, str]] | None:
    """Best one-hero-per-player assignment as (mean weight, hero -> player)."""
    pools = state.player_pools
    if len(pools) < len(composition):
        return None
    options: list[list[tuple[str, float]]] = []
    for hero in composition:
        locked = state.locked_players.get(hero)
        choices = []
        for pool in pools:
            if locked and locked != pool.player:
                continue
            weight = _weight(pool, hero)
            if weight is None:
                continue
            if pool.roles and not set(pool.roles).intersection(heroes.get(hero).roles):
                continue
            choices.append((pool.player, weight))
        if not choices:
            return None
        options.append(choices)
    best: tuple[float, list[str]] | None = None
    def search(index: int, used: set[str], total: float, chosen: list[str]) -> None:
        nonlocal best
        if index == len(composition):
            if best is None or total > best[0]:
                best = (total, list(chosen))
            return
        for player, weight in options[index]:
            if player not in used:
                used.add(player); chosen.append(player)
                search(index + 1, used, total + weight, chosen)
                used.discard(player); chosen.pop()
    search(0, set(), 0.0, [])
    if best is None:
        return None
    return best[0] / len(composition), dict(zip(composition, best[1]))


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
            roster_fit, assignment, rank_score = None, (), None
            if state.player_pools:
                assigned = _assign(composition, heroes, state)
                if assigned is None:
                    continue
                if any(pool.restricted for pool in state.player_pools):
                    roster_fit = round(assigned[0], 4)
                    pools = {pool.player: pool for pool in state.player_pools}
                    assignment = tuple({"hero": hero, "player": player, "mastery": pools[player].mastery.get(hero)}
                                       for hero, player in assigned[1].items())
            remaining = tuple(h for h in composition if h not in ours)
            score, details, score_summary = _score(catalog, remaining, tuple(state.enemy_picks))
            if roster_fit is not None:
                # Roster fit leads; the matchup estimate (centred on 50%) nudges close calls.
                rank_score = round(roster_fit + 2 * ((score if score is not None else 0.5) - 0.5), 4)
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
                                    score, details, score_summary, (), our_bans, opponent_bans, draft_actions,
                                    roster_fit, assignment, rank_score))
    output.sort(key=lambda c: (c.rank_score is not None, c.rank_score or 0.0, c.score is not None, c.score or 0.0,
                               c.score_summary.get("coverage", 0.0) if c.score_summary else 0.0), reverse=True)
    return output[:limit]
