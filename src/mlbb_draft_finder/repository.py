from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

from .models import DraftAction, Hero, MatchDraft, MatchupStat, SynergyStat


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS heroes (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, roles_json TEXT NOT NULL, aliases_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
  source_url TEXT, tournament TEXT NOT NULL, match_date TEXT, patch TEXT,
  team_a TEXT NOT NULL, team_b TEXT NOT NULL, game_number INTEGER,
  stage TEXT, series TEXT, duration TEXT, winner TEXT, team_a_side TEXT, team_b_side TEXT,
  order_available INTEGER NOT NULL DEFAULT 1, bans_known INTEGER NOT NULL DEFAULT 1, source_refs_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('pick','ban')), team TEXT NOT NULL,
  hero TEXT NOT NULL REFERENCES heroes(slug), action_order INTEGER,
  PRIMARY KEY (match_id, phase, team, hero)
);
CREATE TABLE IF NOT EXISTS matchup_stats (
  hero TEXT NOT NULL REFERENCES heroes(slug), opponent TEXT NOT NULL REFERENCES heroes(slug),
  wins INTEGER NOT NULL CHECK (wins >= 0), games INTEGER NOT NULL CHECK (games >= wins), source TEXT,
  PRIMARY KEY (hero, opponent, source)
);
CREATE TABLE IF NOT EXISTS synergy_stats (
  hero TEXT NOT NULL REFERENCES heroes(slug), partner TEXT NOT NULL REFERENCES heroes(slug),
  wins INTEGER NOT NULL CHECK (wins >= 0), games INTEGER NOT NULL CHECK (games >= wins), source TEXT,
  PRIMARY KEY (hero, partner, source)
);
CREATE INDEX IF NOT EXISTS idx_actions_match_phase ON actions(match_id, phase);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament);
"""


def parse_match_date(value: str | None) -> date | None:
    """Parse the date formats found in captured snapshots; None when unreadable."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        for fmt in ("%b %d, %Y", "%B %d, %Y"):
            try:
                return datetime.strptime(value, fmt).date()
            except ValueError:
                continue
    return None


class Catalog:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        # The HTTP server handles requests in worker threads. SQLite serializes
        # the small read/write transactions used here; allowing the connection
        # across threads keeps the catalog simple and dependency-free.
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self._migrate_schema()

    def _migrate_schema(self) -> None:
        """Add fields introduced after the initial local catalog schema."""
        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(matches)")}
        additions = {
            "stage": "TEXT", "series": "TEXT", "duration": "TEXT", "winner": "TEXT",
            "team_a_side": "TEXT", "team_b_side": "TEXT", "bans_known": "INTEGER NOT NULL DEFAULT 1",
        }
        for name, definition in additions.items():
            if name not in columns:
                self.db.execute(f"ALTER TABLE matches ADD COLUMN {name} {definition}")
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def add_heroes(self, heroes: Iterable[Hero]) -> None:
        self.db.executemany(
            "INSERT INTO heroes(slug,name,roles_json,aliases_json) VALUES (?,?,?,?) "
            "ON CONFLICT(slug) DO UPDATE SET name=excluded.name, roles_json=excluded.roles_json, aliases_json=excluded.aliases_json",
            [(h.slug, h.name, json.dumps(h.roles), json.dumps(h.aliases)) for h in heroes],
        )
        self.db.commit()

    def add_match(self, match: MatchDraft) -> bool:
        canonical = self.canonical_key(match)
        try:
            self.db.execute(
                "INSERT INTO matches (id,canonical_key,source,source_url,tournament,match_date,patch,team_a,team_b,game_number,"
                "stage,series,duration,winner,team_a_side,team_b_side,order_available,bans_known,source_refs_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (match.id, canonical, match.source, match.source_url, match.tournament, match.date, match.patch,
                 match.team_a, match.team_b, match.game_number, match.stage, match.series, match.duration, match.winner,
                 match.team_a_side, match.team_b_side, int(match.order_available), int(match.bans_known), json.dumps(match.source_refs)),
            )
        except sqlite3.IntegrityError:
            # Keep provenance when the same game arrives from both Liquipedia
            # and MLBBDex. The canonical match remains a single candidate.
            row = self.db.execute("SELECT id, source_refs_json FROM matches WHERE canonical_key=?", (canonical,)).fetchone()
            if row:
                refs = json.loads(row["source_refs_json"])
                for ref in (list(match.source_refs) or [{"source": match.source, "url": match.source_url}]):
                    if ref not in refs:
                        refs.append(ref)
                self.db.execute("UPDATE matches SET source_refs_json=? WHERE id=?", (json.dumps(refs), row["id"]))
                self.db.commit()
            return False
        self.db.executemany(
            "INSERT INTO actions VALUES (?,?,?,?,?)",
            [(match.id, a.phase, a.team, a.hero, a.order) for a in match.actions],
        )
        self.db.commit()
        return True

    @staticmethod
    def canonical_key(match: MatchDraft) -> str:
        date = match.date or ""
        teams = sorted((match.team_a.strip().lower(), match.team_b.strip().lower()))
        return "|".join((match.tournament.strip().lower(), date, match.series or "", *teams, str(match.game_number or "")))

    def add_matchup_stats(self, stats: Iterable[MatchupStat]) -> None:
        self.db.executemany(
            "INSERT INTO matchup_stats(hero,opponent,wins,games,source) VALUES (?,?,?,?,?) "
            "ON CONFLICT(hero,opponent,source) DO UPDATE SET wins=excluded.wins,games=excluded.games",
            [(s.hero, s.opponent, s.wins, s.games, s.source or "") for s in stats],
        )
        self.db.commit()

    def add_synergy_stats(self, stats: Iterable[SynergyStat]) -> None:
        self.db.executemany(
            "INSERT INTO synergy_stats(hero,partner,wins,games,source) VALUES (?,?,?,?,?) "
            "ON CONFLICT(hero,partner,source) DO UPDATE SET wins=excluded.wins,games=excluded.games",
            [(s.hero, s.partner, s.wins, s.games, s.source or "") for s in stats],
        )
        self.db.commit()

    def heroes(self) -> dict[str, Hero]:
        rows = self.db.execute("SELECT * FROM heroes").fetchall()
        return {r["slug"]: Hero(r["slug"], r["name"], tuple(json.loads(r["roles_json"])), tuple(json.loads(r["aliases_json"]))) for r in rows}

    def usage_window(self, recent_days: int = 180) -> tuple[dict[str, dict[str, int]], int]:
        """Pick/ban frequency per hero over the recent window, plus the number of games in it."""
        matches = self.matches()
        dated = [(m, parse_match_date(m.date)) for m in matches]
        anchor = max((d for _, d in dated if d), default=date.today())
        cutoff = anchor - timedelta(days=recent_days)
        counts = {slug: {"recent_picks": 0, "recent_bans": 0, "recent_games": 0} for slug in self.heroes()}
        seen_games: dict[str, set[str]] = {slug: set() for slug in counts}
        games = 0
        for match, match_date in dated:
            if match_date is None or match_date < cutoff:
                continue
            games += 1
            for action in match.actions:
                row = counts.setdefault(action.hero, {"recent_picks": 0, "recent_bans": 0, "recent_games": 0})
                if action.phase == "pick":
                    row["recent_picks"] += 1
                elif action.phase == "ban":
                    row["recent_bans"] += 1
                seen_games.setdefault(action.hero, set()).add(match.id)
        for slug, row in counts.items():
            row["recent_games"] = len(seen_games.get(slug, set()))
            row["usage_score"] = row["recent_picks"] + row["recent_bans"]
        return counts, games

    def hero_usage(self, recent_days: int = 180) -> dict[str, dict[str, int]]:
        """Return pick/ban frequency for the recent tournament window."""
        return self.usage_window(recent_days)[0]

    def matches(self) -> list[MatchDraft]:
        rows = self.db.execute("SELECT * FROM matches ORDER BY match_date DESC, id").fetchall()
        result: list[MatchDraft] = []
        for r in rows:
            actions = self.db.execute("SELECT * FROM actions WHERE match_id=? ORDER BY action_order IS NULL, action_order", (r["id"],)).fetchall()
            result.append(MatchDraft(r["id"], r["source"], r["source_url"], r["tournament"], r["match_date"], r["patch"],
                                     r["team_a"], r["team_b"], r["game_number"],
                                     [DraftAction(a["phase"], a["team"], a["hero"], a["action_order"]) for a in actions],
                                     bool(r["order_available"]), json.loads(r["source_refs_json"]),
                                     r["stage"], r["series"], r["duration"], r["winner"], r["team_a_side"], r["team_b_side"], bool(r["bans_known"])))
        return result

    def matchup(self, hero: str, opponent: str) -> tuple[int, int]:
        row = self.db.execute("SELECT COALESCE(SUM(wins),0) wins, COALESCE(SUM(games),0) games FROM matchup_stats WHERE hero=? AND opponent=?", (hero, opponent)).fetchone()
        return int(row["wins"]), int(row["games"])

    def relationships(self, hero: str, limit: int = 100) -> dict[str, list[dict]]:
        counters = self.db.execute(
            "SELECT opponent, wins, games, source FROM matchup_stats WHERE hero=? ORDER BY games DESC, wins * 1.0 / games DESC LIMIT ?",
            (hero, limit),
        ).fetchall()
        synergy = self.db.execute(
            "SELECT partner, wins, games, source FROM synergy_stats WHERE hero=? ORDER BY games DESC, wins * 1.0 / games DESC LIMIT ?",
            (hero, limit),
        ).fetchall()
        return {
            "counter": [{"hero": row["opponent"], "wins": row["wins"], "games": row["games"], "win_rate": round(row["wins"] / row["games"], 4), "source": row["source"]} for row in counters],
            "synergy": [{"hero": row["partner"], "wins": row["wins"], "games": row["games"], "win_rate": round(row["wins"] / row["games"], 4), "source": row["source"]} for row in synergy],
        }

    def search(self, tournament: str | None = None, source: str | None = None) -> list[MatchDraft]:
        return [m for m in self.matches() if (not tournament or m.tournament == tournament) and (not source or m.source == source)]
