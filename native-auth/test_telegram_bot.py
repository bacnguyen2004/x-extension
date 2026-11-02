import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from telegram_bot import poll_once
from telegram_ops import _process, live_poller_alive, write_live_heartbeat


class LivePollTests(unittest.TestCase):
    def update(self, uid=123, chat=123, stamp=1000, text="❔ Hướng dẫn"):
        return {"update_id": 42, "message": {"date": stamp, "text": text, "from": {"id": uid, "is_bot": False}, "chat": {"id": chat, "type": "private"}}}

    def test_telemetry_skips_getupdates_while_live_poller_runs(self):
        config = {"telegram_notifications": {"enabled": True, "commands_enabled": True, "chat_id": "123", "bot_token_dpapi": "encrypted"}}
        methods = []
        class Response:
            status_code = 200
            def json(self): return {"ok": True, "result": []}
        def post(url, **kwargs):
            methods.append(url.rsplit("/", 1)[-1])
            return Response()
        with tempfile.TemporaryDirectory() as tmp, patch("telegram_ops.decrypt_hash", return_value="123:fake"):
            write_live_heartbeat(Path(tmp), 1000)
            result = _process(config, {"snapshot": {"status": "waiting", "token": "secret"}}, post, None, Path(tmp), 1000)
            saved = json.loads((Path(tmp) / "ops-state.json").read_text(encoding="utf-8"))
        self.assertTrue(result["livePoll"])
        self.assertNotIn("getUpdates", methods)
        self.assertNotIn("sendMessage", methods)
        self.assertEqual(saved["snapshot"]["status"], "waiting")
        self.assertNotIn("token", saved["snapshot"])

    def test_live_poll_replies_to_help_without_waiting_for_chrome(self):
        config = {"telegram_notifications": {"enabled": True, "commands_enabled": True, "chat_id": "123", "bot_token_dpapi": "encrypted"}}
        captured = []
        class Response:
            status_code = 200
            def __init__(self, body=None): self.body = body or {"ok": True}
            def json(self): return self.body
        def post(url, **kwargs):
            method = url.rsplit("/", 1)[-1]
            if method == "getUpdates":
                return Response({"ok": True, "result": [self.update()]})
            captured.append(kwargs["json"])
            return Response({"ok": True})
        with tempfile.TemporaryDirectory() as tmp, patch("telegram_bot.decrypt_hash", return_value="123:fake"):
            result = poll_once(config, post, Path(tmp), 1000, timeout=0)
            self.assertTrue(live_poller_alive(Path(tmp), 1000))
        self.assertEqual(result["commands"], 1)
        self.assertIn("X CONTENT CREATOR", captured[0]["text"])
        self.assertIn("trả lời ngay", captured[0]["text"])
        self.assertIn("keyboard", captured[0]["reply_markup"])
        self.assertEqual(captured[0]["chat_id"], "123")


if __name__ == "__main__":
    unittest.main()
