"""Exercise the authenticated manual-sync route against an isolated server."""
import unittest
from test_http import Server, q


class SkillSyncHttpTests(unittest.TestCase):
    def test_confirmation_and_sync(self):
        server = Server()
        try:
            self.assertTrue(server.wait_ready(), server.drain())
            status, listing = server.get("/skills")
            self.assertEqual(status, 200)
            skill = listing["skills"][0]
            status, _ = server.post("/skills/save", {
                "id": skill["id"], "name": skill["name"], "description": "edited",
                "body": "user edited body", "enabled": False, "always": True,
            })
            self.assertEqual(status, 200)
            status, _ = server.post("/skills/sync", {"confirmOverwrite": True}, token=None)
            self.assertEqual(status, 401)
            for payload in ({}, {"confirmOverwrite": False}, {"confirmOverwrite": "true"}):
                status, _ = server.post("/skills/sync", payload)
                self.assertEqual(status, 400)
            status, current = server.get(q("/skills/get", id=skill["id"]))
            self.assertEqual(current["skill"]["body"], "user edited body")
            status, result = server.post("/skills/sync", {"confirmOverwrite": True})
            self.assertEqual(status, 200, result)
            self.assertGreater(result["updated"], 0)
            status, current = server.get(q("/skills/get", id=skill["id"]))
            self.assertNotEqual(current["skill"]["body"], "user edited body")
            self.assertFalse(current["skill"]["enabled"])
            self.assertTrue(current["skill"]["always"])
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
