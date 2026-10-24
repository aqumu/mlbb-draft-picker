"""Source-neutral imports plus rate-limited API clients.

The importer deliberately consumes structured exports. It never scrapes generated
Liquipedia HTML; this keeps attribution, caching, and source terms explicit.
"""

from __future__ import annotations

import json
import gzip
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .models import DraftAction, Hero, MatchDraft, MatchupStat
from .repository import Catalog


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
