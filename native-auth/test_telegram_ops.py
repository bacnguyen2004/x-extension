import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from telegram_ops import authorized_command, format_status, _process


class OpsTests(unittest.TestCase):
    def update(self, uid=123, chat=123, stamp=1000, text="/status", kind="private"):
        return {"update_id": 42, "message": {"date": stamp, "text": text, "from": {"id": uid, "is_bot": False}, "chat": {"id": chat, "type": kind}}}

    def test_command_authorization_and_freshness(self):
        settings = {"chat_id": "123", "bot_username": "my_bot"}
        self.assertEqual(authorized_command(self.update(), settings, 1000), "/status")
        self.assertIsNone(authorized_command(self.update(uid=999), settings, 1000))
        self.assertIsNone(authorized_command(self.update(chat=999), settings, 1000))
        self.assertIsNone(authorized_command(self.update(stamp=1), settings, 1000))
        self.assertIsNone(authorized_command(self.update(text="/status@other_bot"), settings, 1000))
        group = {"chat_id": "-100", "allowed_user_ids": [123]}
        self.assertEqual(authorized_command(self.update(chat=-100, kind="supergroup"), group, 1000), "/status")
        self.assertIsNone(authorized_command(self.update(uid=999, chat=-100, kind="supergroup"), group, 1000))
        self.assertIsNone(authorized_command(self.update(text="/stop"), settings, 1000))

    def test_status_whitelists_data_and_splits_platform_and_tool_state(self):
        text = format_status({"account": "viewer", "status": "waiting", "restReason": "Tải cao", "pogoReady": True,
            "counters": {"reply": 7}, "token": "private-token", "detail": "private-error", "healthy": True})
        self.assertIn("@viewer", text)
        self.assertIn("Reply: <b>7</b>", text)
        self.assertNotIn("private", text)

    def test_menu_buttons_and_today_keep_command_authorization(self):
        settings = {"chat_id": "123", "bot_username": "my_bot"}
        for text, expected in [("📊 Trạng thái", "/status"), ("📈 Hôm nay", "/today"), ("❔ Hướng dẫn", "/help"), ("/today@my_bot", "/today")]:
            self.assertEqual(authorized_command(self.update(text=text), settings, 1000), expected)
            self.assertIsNone(authorized_command(self.update(uid=999, text=text), settings, 1000))
        self.assertIsNone(authorized_command(self.update(text="/stop"), settings, 1000))

    def test_start_opens_menu_and_today_returns_formatted_read_only_stats(self):
        settings = {"telegram_notifications": {"enabled": True, "commands_enabled": True, "chat_id": "123", "bot_token_dpapi": "encrypted"}}
        captured = []
        class Response:
            status_code = 200
            def __init__(self, body): self.body = body
            def json(self): return self.body
        command = "/start"
        def post(url, **kwargs):
            data = kwargs["json"]
            if url.endswith("setMyCommands"):
                return Response({"ok": True, "result": True})
            if url.endswith("getUpdates"):
                update = self.update(text=command)
                update["update_id"] = 42 if command == "/start" else 43
                return Response({"ok": True, "result": [update]})
            captured.append(data)
            return Response({"ok": True})
        with tempfile.TemporaryDirectory() as tmp, patch("telegram_ops.decrypt_hash", return_value="123:fake"):
            _process(settings, {"snapshot": {}}, post, None, Path(tmp), 1000)
            command = "/today"
            _process(settings, {"snapshot": {"account": "viewer", "counters": {"reply": 232, "like": 466}}}, post, None, Path(tmp), 1001)
        self.assertIn("keyboard", captured[0]["reply_markup"])
        self.assertEqual(captured[0]["parse_mode"], "HTML")
        self.assertIn("<b>232</b>", captured[1]["text"])
        self.assertIn("<b>466</b>", captured[1]["text"])
        self.assertTrue(captured[1]["disable_notification"])
        self.assertEqual(captured[1]["chat_id"], "123")

    def test_offset_and_daily_delivery_survive_restarts(self):
        settings = {"telegram_notifications": {"enabled": True, "commands_enabled": True, "chat_id": "123", "bot_token_dpapi": "encrypted"}}
        calls = []
        class Response:
            status_code = 200
            def __init__(self, body): self.body = body
            def json(self): return self.body
        def post(url, **kwargs):
            calls.append((url.rsplit("/", 1)[-1], kwargs["json"]))
            return Response({"ok": True, "result": [self.update()] if url.endswith("getUpdates") else {}})
        message = {"snapshot": {"status": "waiting"}, "reports": [{"id": "viewer:2026-10-23", "account": "viewer", "date": "2026-10-23", "counters": {"reply": 4}}]}
        with tempfile.TemporaryDirectory() as tmp, patch("telegram_ops.decrypt_hash", return_value="123:fake"):
            a = _process(settings, message, post, None, Path(tmp), 1000)
            b = _process(settings, message, post, None, Path(tmp), 1001)
        self.assertEqual(a["commands"], 1)
        self.assertEqual(b["commands"], 0)
        self.assertEqual(b["reported"], ["viewer:2026-10-23"])
        self.assertEqual(sum(method == "sendMessage" for method, _ in calls), 2)
        self.assertEqual(calls[-1][1]["offset"], 43)

    def test_heartbeat_is_external_throttled_and_reports_a_stalled_worker(self):
        config = {"healthchecks": {"enabled": True, "url_dpapi": "encrypted"}}
        urls = []
        class Response:
            status_code = 200
            text = "OK"
        def get(url, **kwargs):
            self.assertFalse(kwargs["allow_redirects"])
            urls.append(url); return Response()
        with tempfile.TemporaryDirectory() as tmp, patch("telegram_ops.decrypt_hash", return_value="https://hc-ping.com/00000000-0000-0000-0000-000000000001"):
            _process(config, {"snapshot": {"healthy": True}}, None, get, Path(tmp), 1000)
            _process(config, {"snapshot": {"healthy": True}}, None, get, Path(tmp), 1060)
            _process(config, {"snapshot": {"healthy": False}}, None, get, Path(tmp), 1100)
        self.assertEqual(len(urls), 2)
        self.assertTrue(urls[1].endswith("/fail"))

    def test_slash_commands_register_once_per_chat_and_survive_restart(self):
        config = {"telegram_notifications": {"enabled": True, "commands_enabled": True, "chat_id": "123", "bot_token_dpapi": "encrypted"}}
        calls = []
        class Response:
            status_code = 200
            def __init__(self, body): self.body = body
            def json(self): return self.body
        def post(url, **kwargs):
            method = url.rsplit("/", 1)[-1]
            calls.append((method, kwargs["json"]))
            return Response({"ok": True, "result": [] if method == "getUpdates" else True})
        with tempfile.TemporaryDirectory() as tmp, patch("telegram_ops.decrypt_hash", return_value="123:fake"):
            first = _process(config, {"snapshot": {}}, post, None, Path(tmp), 1000)
            _process(config, {"snapshot": {}}, post, None, Path(tmp), 1060)
            self.assertTrue(first["menuRegistered"])
            self.assertEqual(sum(method == "setMyCommands" for method, _ in calls), 1)
            config["telegram_notifications"]["chat_id"] = "456"
            _process(config, {"snapshot": {}}, post, None, Path(tmp), 1120)
        menus = [body for method, body in calls if method == "setMyCommands"]
        self.assertEqual([command["command"] for command in menus[0]["commands"]], ["start", "status", "today", "help"])
        self.assertEqual(menus[0]["scope"], {"type": "chat", "chat_id": "123"})
        self.assertEqual(menus[1]["scope"]["chat_id"], "456")
        self.assertTrue(all(method != "sendMessage" for method, _ in calls))

    def test_slash_registration_failure_retries_without_blocking_update_polling(self):
        config = {"telegram_notifications": {"enabled": True, "commands_enabled": True, "chat_id": "123", "bot_token_dpapi": "encrypted"}}
        methods = []
        class Response:
            status_code = 200
            def __init__(self, body): self.body = body
            def json(self): return self.body
        def post(url, **kwargs):
            method = url.rsplit("/", 1)[-1]; methods.append(method)
            if method == "setMyCommands" and methods.count(method) == 1:
                raise RuntimeError("private credential detail")
            return Response({"ok": True, "result": [] if method == "getUpdates" else True})
        with tempfile.TemporaryDirectory() as tmp, patch("telegram_ops.decrypt_hash", return_value="123:fake"):
            first = _process(config, {"snapshot": {}}, post, None, Path(tmp), 1000)
            second = _process(config, {"snapshot": {}}, post, None, Path(tmp), 1060)
        self.assertEqual(first["menuError"], "bot_menu_registration_failed")
        self.assertTrue(second["menuRegistered"])
        self.assertEqual(methods.count("getUpdates"), 2)
        self.assertNotIn("private", str(first))


if __name__ == "__main__": unittest.main()
