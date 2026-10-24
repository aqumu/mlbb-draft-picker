"""Source-neutral imports plus rate-limited API clients.

The importer deliberately consumes structured exports. It never scrapes generated
Liquipedia HTML; this keeps attribution, caching, and source terms explicit.
"""

from __future__ import annotations

import json
import gzip
import csv
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .models import DraftAction, Hero, MatchDraft, MatchupStat
from .repository import Catalog


HERO_CSV_COLUMNS = ("slug", "name", "roles", "aliases")
DRAFT_CSV_COLUMNS = (
    "match_id", "source", "source_url", "tournament", "date", "patch", "team_a", "team_b", "game_number",
    "order_available", "action_order", "phase", "team", "hero",
)


def _csv_rows(path: str | Path, required: tuple[str, ...]) -> list[dict[str, str]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [column for column in required if column not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{path}: missing columns: {', '.join(missing)}")
        return [{key: (value or "").strip() for key, value in row.items()} for row in reader]


def _split_cell(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in value.split("|") if item.strip())


def read_heroes_csv(path: str | Path) -> list[Hero]:
    rows = _csv_rows(path, HERO_CSV_COLUMNS)
    heroes: list[Hero] = []
    seen: set[str] = set()
    for number, row in enumerate(rows, 2):
        if not row["slug"] or not row["name"]:
            raise ValueError(f"{path}:{number}: slug and name are required")
        if row["slug"] in seen:
            raise ValueError(f"{path}:{number}: duplicate hero slug {row['slug']}")
        seen.add(row["slug"])
        heroes.append(Hero(row["slug"], row["name"], _split_cell(row["roles"]), _split_cell(row["aliases"])))
    return heroes


def read_drafts_csv(path: str | Path, known_heroes: set[str]) -> list[MatchDraft]:
    rows = _csv_rows(path, DRAFT_CSV_COLUMNS)
    grouped: dict[str, list[dict[str, str]]] = {}
    for number, row in enumerate(rows, 2):
        if not row["match_id"] or not row["source"] or not row["source_url"] or not row["tournament"]:
            raise ValueError(f"{path}:{number}: match_id, source, source_url, and tournament are required")
        if row["phase"] not in {"pick", "ban"} or row["team"] not in {"team_a", "team_b"}:
            raise ValueError(f"{path}:{number}: phase must be pick/ban and team must be team_a/team_b")
        if row["hero"] not in known_heroes:
            raise ValueError(f"{path}:{number}: unknown hero slug {row['hero']}")
        if row["action_order"]:
            try:
                if int(row["action_order"]) < 1:
                    raise ValueError
            except ValueError as exc:
                raise ValueError(f"{path}:{number}: action_order must be a positive integer") from exc
        grouped.setdefault(row["match_id"], []).append(row)

    matches: list[MatchDraft] = []
    for match_id, match_rows in grouped.items():
        first = match_rows[0]
        metadata_fields = ("source", "source_url", "tournament", "date", "patch", "team_a", "team_b", "game_number", "order_available")
        for row in match_rows[1:]:
            for field in metadata_fields:
                if row[field] != first[field]:
                    raise ValueError(f"{path}: match {match_id} has inconsistent {field}")
        actions = [DraftAction(row["phase"], row["team"], row["hero"], int(row["action_order"]) if row["action_order"] else None) for row in match_rows]
        picks_a = [a.hero for a in actions if a.phase == "pick" and a.team == "team_a"]
        picks_b = [a.hero for a in actions if a.phase == "pick" and a.team == "team_b"]
        if len(picks_a) != 5 or len(picks_b) != 5:
            raise ValueError(f"{path}: match {match_id} must contain exactly five picks for each team")
        if len(set(picks_a + picks_b)) != len(picks_a + picks_b):
            raise ValueError(f"{path}: match {match_id} contains a hero picked twice")
        order_available = first["order_available"].lower() in {"1", "true", "yes"}
        if not first["order_available"]:
            order_available = all(action.order is not None for action in actions)
        matches.append(MatchDraft(
            id=match_id, source=first["source"], source_url=first["source_url"], tournament=first["tournament"],
            date=first["date"] or None, patch=first["patch"] or None, team_a=first["team_a"] or "Team A", team_b=first["team_b"] or "Team B",
            game_number=int(first["game_number"]) if first["game_number"] else None, actions=actions, order_available=order_available,
            source_refs=[{"source": first["source"], "url": first["source_url"]}],
        ))
    return matches


def import_csv_files(catalog: Catalog, heroes_path: str | Path, drafts_path: str | Path) -> dict[str, int]:
    heroes = read_heroes_csv(heroes_path)
    catalog.add_heroes(heroes)
    matches = read_drafts_csv(drafts_path, {hero.slug for hero in heroes})
    added = sum(catalog.add_match(match) for match in matches)
    return {"heroes": len(heroes), "matches_added": added, "matches_seen": len(matches), "matchup_stats": 0}


def _match(value: dict[str, Any], default_source: str) -> MatchDraft:
    actions = [DraftAction(str(a["phase"]), str(a["team"]), str(a["hero"]), a.get("order")) for a in value.get("actions", [])]
    return MatchDraft(id=str(value["id"]), source=str(value.get("source", default_source)), source_url=value.get("source_url"),
                      tournament=str(value.get("tournament", "Unknown tournament")), date=value.get("date"), patch=value.get("patch"),
                      team_a=str(value.get("team_a", "Team A")), team_b=str(value.get("team_b", "Team B")),
                      game_number=value.get("game_number"), actions=actions,
                      order_available=bool(value.get("order_available", all(a.order is not None for a in actions))),
                      source_refs=list(value.get("source_refs") or ([{"source": str(value.get("source", default_source)), "url": value.get("source_url")}]
                                                                     if value.get("source_url") else [])))


def import_payload(catalog: Catalog, payload: dict[str, Any], source: str = "import") -> dict[str, int]:
    heroes = [Hero(str(h["slug"]), str(h["name"]), tuple(h.get("roles", [])), tuple(h.get("aliases", []))) for h in payload.get("heroes", [])]
    catalog.add_heroes(heroes)
    matches = payload.get("matches", [])
    added = sum(catalog.add_match(_match(m, source)) for m in matches)
    stats = [MatchupStat(str(s["hero"]), str(s["opponent"]), int(s["wins"]), int(s["games"]), s.get("source")) for s in payload.get("matchup_stats", [])]
    catalog.add_matchup_stats(stats)
    return {"heroes": len(heroes), "matches_added": added, "matches_seen": len(matches), "matchup_stats": len(stats)}


def import_json_file(catalog: Catalog, path: str | Path, source: str = "import") -> dict[str, int]:
    with open(path, "r", encoding="utf-8") as handle:
        return import_payload(catalog, json.load(handle), source)


class JsonApiClient:
    """Small cached JSON client used by source adapters and scheduled ingestion."""

    def __init__(self, base_url: str, user_agent: str, cache_dir: str | Path = "data/cache", min_interval: float = 2.0, api_key: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.min_interval = min_interval
        self.api_key = api_key
        self._last_request = 0.0

    def get(self, path: str, params: dict[str, str] | None = None, cache_name: str | None = None) -> dict[str, Any]:
        cache_file = self.cache_dir / (cache_name or (path.strip("/").replace("/", "_") + ".json"))
        if cache_file.exists():
            return json.loads(cache_file.read_text(encoding="utf-8"))
        wait = self.min_interval - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        query = ("?" + urlencode(params)) if params else ""
        request = Request(self.base_url + "/" + path.lstrip("/") + query, headers={"User-Agent": self.user_agent, "Accept-Encoding": "gzip"})
        if self.api_key:
            request.add_header("Authorization", "Bearer " + self.api_key)
        with urlopen(request, timeout=30) as response:
            body = response.read()
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                body = gzip.decompress(body)
            data = json.loads(body.decode("utf-8"))
        self._last_request = time.monotonic()
        cache_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data


class LiquipediaAdapter:
    """Adapter boundary for Liquipedia's approved API/export format."""

    def __init__(self, client: JsonApiClient):
        self.client = client

    def fetch_export(self, path: str = "mlbb/drafts") -> dict[str, Any]:
        return self.client.get(path, cache_name="liquipedia_drafts.json")


class MLBBDexAdapter:
    """Adapter boundary for an MLBBDex export or future draft endpoint.

    MLBBDex's documented public API currently exposes heroes, items, patches,
    and rankings rather than individual pro-match drafts, so a draft export
    path must be supplied by the operator instead of being guessed here.
    """

    def __init__(self, client: JsonApiClient):
        self.client = client

    def fetch_export(self, path: str) -> dict[str, Any]:
        return self.client.get(path, cache_name="mlbbdex_drafts.json")
