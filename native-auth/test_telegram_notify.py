import unittest
from unittest.mock import patch
import pogo_auth as auth
from telegram_notify import send_notification


class NotificationTests(unittest.TestCase):
    def test_disabled_does_not_send(self):
        self.assertTrue(send_notification({}, {"event": "test"}, lambda *a, **k: self.fail("unexpected request"))["skipped"])

    def test_send_uses_fixed_destination_and_no_raw_error_text(self):
        config = {"telegram_notifications": {"enabled": True, "chat_id": "123", "bot_token_dpapi": "encrypted"}}
        class Response:
            status_code = 200
            def json(self): return {"ok": True}
        def post(url, **kwargs):
            self.assertEqual(kwargs["json"]["chat_id"], "123")
            self.assertNotIn("secret", kwargs["json"]["text"])
            self.assertFalse(kwargs["allow_redirects"])
            return Response()
        with patch("telegram_notify.decrypt_hash", return_value="123:fake"):
            self.assertTrue(send_notification(config, {"event": "agent_error", "text": "secret", "chat_id": "999"}, post)["ok"])
            with self.assertRaisesRegex(auth.AuthError, "notification_event_invalid"):
                send_notification(config, {"event": "arbitrary"}, post)
            with self.assertRaisesRegex(auth.AuthError, "^notification_send_failed$"):
                send_notification(config, {"event": "test"}, lambda *a, **k: (_ for _ in ()).throw(Exception("secret token URL")))

    def test_bounty_alert_uses_fixed_template(self):
        config = {"telegram_notifications": {"enabled": True, "chat_id": "123", "bot_token_dpapi": "encrypted"}}
        captured = {}
        class Response:
            status_code = 200
            def json(self): return {"ok": True}
        def post(url, **kwargs):
            captured.update(kwargs["json"])
            return Response()
        with patch("telegram_notify.decrypt_hash", return_value="123:fake"):
            send_notification(config, {
                "event": "pogo_bounty",
                "account": "viewer",
                "bounty": {"kind": "joined", "id": 99, "title": "Open\nbounty", "fee": 0, "slots": 3, "secret": "nope"},
            }, post)
        self.assertTrue(captured["text"].startswith("<b>✅ Đã join bounty Pogo</b>"))
        self.assertIn("<b>Open bounty</b>", captured["text"])
        self.assertIn("<code>#99</code>", captured["text"])
        self.assertEqual(captured["parse_mode"], "HTML")
        self.assertEqual(captured["reply_markup"]["inline_keyboard"][0][0]["url"], "https://pogo.social/")
        self.assertTrue(captured["disable_notification"])
        self.assertNotIn("nope", captured["text"])
        with patch("telegram_notify.decrypt_hash", return_value="123:fake"):
            send_notification(config, {"event": "pogo_bounty", "bounty": {
                "kind": "uncertain", "id": 99, "title": "FCFS", "reason": "network_error",
                "fee": 0, "slots": 2, "url": "https://untrusted.invalid/secret",
            }}, post)
        self.assertIn("Chưa rõ kết quả", captured["text"])
        self.assertEqual(captured["reply_markup"]["inline_keyboard"][0][0]["url"], "https://pogo.social/")
        self.assertFalse(captured["disable_notification"])
        self.assertIn("join tay nếu chưa join", captured["text"])
        self.assertNotIn("untrusted", captured["text"])
        with patch("telegram_notify.decrypt_hash", return_value="123:fake"):
            with self.assertRaisesRegex(auth.AuthError, "notification_event_invalid"):
                send_notification(config, {"event": "pogo_bounty", "bounty": {"kind": "hack", "id": 99}}, post)

    def test_bounty_title_is_escaped_and_timestamp_is_the_original_discovery(self):
        from telegram_notify import notification_payload
        result = notification_payload({"event": "pogo_bounty", "at": 1793034000000,
            "bounty": {"kind": "new", "id": 8, "title": "A <b>fake</b> & B", "fee": 0, "slots": 1,
                "url": "https://untrusted.invalid", "token": "private-secret"}})
        self.assertIn("A &lt;b&gt;fake&lt;/b&gt; &amp; B", result["text"])
        self.assertIn("<code>#8</code>", result["text"])
        self.assertIn("VN", result["text"])
        self.assertNotIn("untrusted", str(result))
        self.assertNotIn("private-secret", str(result))
        self.assertFalse(result["disable_notification"])
        from telegram_ui import stamp
        self.assertIn(stamp(1793034000000), result["text"])


if __name__ == "__main__": unittest.main()
