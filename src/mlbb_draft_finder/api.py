from __future__ import annotations

import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .matcher import find_candidates
from .models import DraftState, PlayerPool
from .repository import Catalog


def _state(payload: dict[str, Any], catalog: Catalog) -> DraftState:
    heroes = catalog.heroes()
    aliases = {a.lower(): slug for slug, h in heroes.items() for a in (h.name, slug, *h.aliases)}
    def resolve(values: Any) -> tuple[str, ...]:
        result = []
        for value in values or []:
            key = aliases.get(str(value).strip().lower(), str(value).strip().lower())
            if key not in heroes:
                raise ValueError(f"Unknown hero: {value}")
            result.append(key)
        return tuple(result)
    pools = []
    for raw in payload.get("player_pools", []):
        pools.append(PlayerPool(str(raw["player"]), tuple(raw.get("roles", [])), frozenset(resolve(raw.get("can_play"))), frozenset(resolve(raw.get("cannot_play")))))
    available = payload.get("available_heroes")
    return DraftState(resolve(payload.get("our_picks")), resolve(payload.get("enemy_picks")), resolve(payload.get("bans")), tuple(pools),
                       {aliases.get(str(k).strip().lower(), str(k).strip().lower()): str(v) for k, v in payload.get("locked_players", {}).items()},
                       frozenset(resolve(available)) if available is not None else None,
                       resolve(payload.get("excluded_heroes")),
                       str(payload.get("our_side")).strip().lower() if payload.get("our_side") else None)


def create_handler(catalog: Catalog):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: Any) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()

        def do_GET(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path == "/v1/health":
                self._send(200, {"status": "ok", "matches": len(catalog.matches()), "heroes": len(catalog.heroes())})
            elif parsed.path == "/v1/heroes":
                usage = catalog.hero_usage()
                self._send(200, [{"slug": h.slug, "name": h.name, "roles": list(h.roles), "aliases": list(h.aliases),
                                  **usage.get(h.slug, {"recent_picks": 0, "recent_bans": 0, "recent_games": 0, "usage_score": 0}),
                                  "recent_window_days": 180} for h in catalog.heroes().values()])
            elif parsed.path == "/v1/matches":
                self._send(200, [_match_as_dict(m) for m in catalog.matches()])
            elif parsed.path == "/v1/relationships":
                hero = parse_qs(parsed.query).get("hero", [""])[0].strip().lower()
                if not hero or hero not in catalog.heroes():
                    self._send(400, {"error": "invalid_request", "message": "hero query parameter is required"})
                else:
                    self._send(200, {"hero": hero, **catalog.relationships(hero)})
            else:
                self._send(404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path != "/v1/candidates":
                self._send(404, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                limit = max(1, min(int(payload.get("limit", 50)), 200))
                candidates = find_candidates(catalog, _state(payload, catalog), limit)
                self._send(200, {"candidates": [candidate.as_dict() for candidate in candidates], "count": len(candidates)})
            except (ValueError, KeyError, json.JSONDecodeError) as exc:
                self._send(400, {"error": "invalid_request", "message": str(exc)})

        def log_message(self, format: str, *args: Any) -> None:
            return
    return Handler


def _match_as_dict(match) -> dict[str, Any]:
    """Serialize a match with both sides' complete draft information."""
    actions = [{"phase": action.phase, "team": action.team, "hero": action.hero, "order": action.order}
               for action in match.actions]
    return {
        "id": match.id,
        "source": match.source,
        "source_url": match.source_url,
        "source_refs": match.source_refs,
        "tournament": match.tournament,
        "date": match.date,
        "patch": match.patch,
        "stage": match.stage,
        "series": match.series,
        "duration": match.duration,
        "winner": match.winner,
        "game_number": match.game_number,
        "order_available": match.order_available,
        "bans_known": match.bans_known,
        "team_a": match.team_a,
        "team_b": match.team_b,
        "teams": {
            "team_a": {"name": match.team_a, "side": match.team_a_side, "picks": match.picks("team_a"),
                       "bans": match.bans_for("team_a")},
            "team_b": {"name": match.team_b, "side": match.team_b_side, "picks": match.picks("team_b"),
                       "bans": match.bans_for("team_b")},
        },
        "actions": actions,
    }


def serve(catalog: Catalog, host: str = "0.0.0.0", port: int = 8080) -> None:
    server = ThreadingHTTPServer((host, port), create_handler(catalog))
    print(f"MLBB Draft Finder API listening on http://{host}:{port}")
    server.serve_forever()
