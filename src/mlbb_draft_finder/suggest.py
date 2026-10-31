"""Opening-draft suggestions: flex picks and bans.

Deliberately not a per-hero "best next pick" engine. It only surfaces what is
plainly visible in pro play: heroes that can go in several lanes (flex picks) and
heroes worth spending a ban on, weighing how contested they are in tournaments,
how flexible they are, and whether *your* roster would rather play them.
"""
from __future__ import annotations

from .matcher import _weight
from .models import DraftState
from .repository import Catalog

LANE_LABELS = {"exp": "EXP", "mid": "Mid", "jungle": "Jungle", "gold": "Gold", "roam": "Roam"}
FLEX_BONUS = 0.25          # ban-score bonus per extra lane a hero can fill
OWN_PLAY_DISCOUNT = 0.8    # a hero a master plays loses this share of its ban score


def team_fit(state: DraftState, hero: str) -> float | None:
    """Best mastery weight any of our players has with the hero (0 = nobody); None without pools."""
    if not any(pool.restricted for pool in state.player_pools):
        return None
    best = 0.0
    for pool in state.player_pools:
        for _, slot in pool.slots():
            weight = _weight(slot, hero)
            if weight is not None and weight > best:
                best = weight
    return best


def _fit_label(fit: float) -> str:
    return "Master" if fit >= 1.0 else "Average" if fit >= 0.75 else "Learning" if fit > 0.45 else "Anyone, no real pool"


def suggest(catalog: Catalog, state: DraftState, hero_lanes: dict[str, list[str]], limit: int = 8) -> dict:
    usage, games = catalog.usage_window()
    taken = set(state.our_picks) | set(state.enemy_picks) | set(state.bans) | set(state.excluded_heroes)
    flex: list[dict] = []
    bans: list[dict] = []
    for hero in catalog.heroes().values():
        if hero.slug in taken or not games:
            continue
        row = usage.get(hero.slug, {})
        # Share of team drafts (two per game), so a hero banned by both sides is 100%, never 200%.
        pick_rate = row.get("recent_picks", 0) / (2 * games)
        ban_rate = row.get("recent_bans", 0) / (2 * games)
        if not pick_rate and not ban_rate:
            continue
        lanes = hero_lanes.get(hero.slug, [])
        fit = team_fit(state, hero.slug)
        info = {"hero": hero.slug, "name": hero.name, "lanes": lanes, "pick_rate": round(pick_rate, 3), "ban_rate": round(ban_rate, 3),
                "team_fit": fit, "team_level": _fit_label(fit) if fit else None}
        lane_text = " / ".join(LANE_LABELS.get(lane, lane) for lane in lanes)
        if len(lanes) >= 2 and pick_rate and fit != 0:
            score = pick_rate * len(lanes) * (0.3 + 0.7 * fit if fit is not None else 1.0)
            reasons = [f"Flex: {lane_text}", f"Picked in {pick_rate:.0%} of recent pro drafts"]
            if fit:
                reasons.append(f"Your team: {_fit_label(fit)}")
            flex.append({**info, "score": round(score, 4), "reasons": reasons})
        ban_score = (ban_rate + pick_rate) * (1 + FLEX_BONUS * max(len(lanes) - 1, 0))
        reasons = [f"Banned in {ban_rate:.0%} and picked in {pick_rate:.0%} of recent pro drafts"]
        if len(lanes) >= 2:
            reasons.append(f"Flex: {lane_text}")
        if fit:
            ban_score *= 1 - OWN_PLAY_DISCOUNT * fit
            reasons.append(f"Your team plays it ({_fit_label(fit)}); you may want to pick it instead")
        elif fit == 0:
            reasons.append("Nobody on your team plays it, so banning it costs you nothing")
        bans.append({**info, "score": round(ban_score, 4), "reasons": reasons})
    flex.sort(key=lambda item: item["score"], reverse=True)
    bans.sort(key=lambda item: item["score"], reverse=True)
    return {"flex_picks": flex[:limit], "bans": bans[:limit + 2], "games": games, "window_days": 180}
