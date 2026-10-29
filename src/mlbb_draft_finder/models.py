from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Hero:
    slug: str
    name: str
    roles: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class DraftAction:
    phase: str  # pick or ban
    team: str  # team_a or team_b
    hero: str
    order: int | None = None


@dataclass
class MatchDraft:
    id: str
    source: str
    source_url: str | None
    tournament: str
    date: str | None
    patch: str | None
    team_a: str
    team_b: str
    game_number: int | None
    actions: list[DraftAction]
    order_available: bool = True
    source_refs: list[dict[str, str]] = field(default_factory=list)
    stage: str | None = None
    series: str | None = None
    duration: str | None = None
    winner: str | None = None
    team_a_side: str | None = None
    team_b_side: str | None = None
    bans_known: bool = True

    def picks(self, team: str) -> list[str]:
        return [a.hero for a in sorted(self.actions, key=lambda a: (a.order is None, a.order or 0))
                if a.phase == "pick" and a.team == team]

    def bans_for(self, team: str) -> list[str]:
        return [a.hero for a in sorted(self.actions, key=lambda a: (a.order is None, a.order or 0))
                if a.phase == "ban" and a.team == team]

    def bans(self) -> list[str]:
        """Return both teams' bans, preserving the historical API behavior."""
        return [a.hero for a in sorted(self.actions, key=lambda a: (a.order is None, a.order or 0)) if a.phase == "ban"]


@dataclass(frozen=True)
class PlayerPool:
    player: str
    roles: tuple[str, ...] = ()
    can_play: frozenset[str] = frozenset()
    cannot_play: frozenset[str] = frozenset()
    # hero -> mastery level (1 learning, 2 average, 3 master). A player with
    # neither mastery nor can_play entries is a wildcard that may play any hero.
    mastery: dict[str, int] = field(default_factory=dict)
    # lane -> {hero: mastery level}. A listed lane with an empty hero map means
    # "plays this lane, any hero". Without lanes the player is lane-agnostic.
    lanes: dict[str, dict[str, int]] = field(default_factory=dict)

    def slots(self) -> list[tuple[str, dict[str, int] | None]]:
        """(lane, hero -> level) options this player can fill; None means any hero."""
        if self.lanes:
            return [(lane, heroes or None) for lane, heroes in self.lanes.items()]
        pool = {**{hero: 2 for hero in self.can_play}, **self.mastery}
        return [("any", pool or None)]

    @property
    def restricted(self) -> bool:
        return any(heroes is not None for _, heroes in self.slots())


@dataclass(frozen=True)
class DraftState:
    our_picks: tuple[str, ...] = ()
    enemy_picks: tuple[str, ...] = ()
    bans: tuple[str, ...] = ()
    player_pools: tuple[PlayerPool, ...] = ()
    locked_players: dict[str, str] = field(default_factory=dict)  # hero -> player
    available_heroes: frozenset[str] | None = None
    excluded_heroes: tuple[str, ...] = ()
    our_side: str | None = None


@dataclass(frozen=True)
class MatchupStat:
    hero: str
    opponent: str
    wins: int
    games: int
    source: str | None = None


@dataclass(frozen=True)
class SynergyStat:
    hero: str
    partner: str
    wins: int
    games: int
    source: str | None = None


def normalize_slug(value: str) -> str:
    return "-".join(value.strip().lower().replace("'", "").split())


def as_tuple(values: Any) -> tuple[str, ...]:
    return tuple(str(v) for v in (values or ()))
