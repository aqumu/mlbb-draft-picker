import json
import threading
import unittest
import urllib.request

from mlbb_draft_finder.api import create_handler
from mlbb_draft_finder.ingest import import_json_file
from mlbb_draft_finder.repository import Catalog
from http.server import ThreadingHTTPServer
from pathlib import Path


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.catalog = Catalog()
        import_json_file(self.catalog, Path(__file__).parents[1] / "data/sample_catalog.json", "sample")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(self.catalog))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.catalog.close()

    def get(self, path):
        with urllib.request.urlopen(self.base + path) as response:
            return json.loads(response.read())

    def test_health_and_candidate_endpoint(self):
        self.assertEqual(self.get("/v1/health")["status"], "ok")
        request = urllib.request.Request(self.base + "/v1/candidates", data=json.dumps({"our_picks": ["Fredrinn"], "enemy_picks": ["Atlas"]}).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request) as response:
            body = json.loads(response.read())
        self.assertGreater(body["count"], 0)
        self.assertIn("metadata", body["candidates"][0])

    def test_player_mastery_ranks_and_reports_assignment(self):
        pools = [{"player": "p0", "heroes": {"fredrinn": 3}}, {"player": "p1", "heroes": {"joy": "average"}},
                 {"player": "p2", "heroes": {"pharsa": 1}}, {"player": "p3", "heroes": {}}, {"player": "p4", "heroes": {}}]
        request = urllib.request.Request(self.base + "/v1/candidates", data=json.dumps({"our_picks": ["fredrinn"], "player_pools": pools}).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request) as response:
            body = json.loads(response.read())
        first = body["candidates"][0]
        self.assertIsNotNone(first["roster_fit"])
        self.assertEqual({a["hero"] for a in first["assignment"]}, set(first["our_picks"]))


if __name__ == "__main__":
    unittest.main()
