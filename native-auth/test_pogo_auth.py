import io
import json
import struct
import unittest
from unittest.mock import patch, AsyncMock
from types import SimpleNamespace
from urllib.parse import quote
import pogo_auth as auth


class AuthTests(unittest.TestCase):
    def test_signed_data_is_decoded_once(self):
        signed = "user=%7B%22id%22%3A1%7D&auth_date=1900000000&hash=a%2Bb"
        url = "https://pogo.social/app#tgWebAppData=" + quote(signed, safe="")
        self.assertEqual(auth.extract_init_data(url), signed)
        with self.assertRaises(auth.AuthError):
            auth.extract_init_data(url.replace("pogo.social", "evil.example"))

    def test_missing_endpoint_does_not_contact_telegram(self):
        with patch.object(auth, "load_config", return_value={"pogo_login": {}}), patch.object(auth, "fresh_init_data") as telegram:
            with self.assertRaisesRegex(auth.AuthError, "pogo_endpoint_not_configured"):
                auth.handle({"action": "get_token"})
            telegram.assert_not_called()

    def test_endpoint_restrictions(self):
        for url in ["http://pogo.social/api/login", "https://evil.example/api/login", "https://pogo.social@evil.example/api/login", "https://pogo.social/api/login?secret=1"]:
            with self.assertRaises(auth.AuthError):
                auth.auth_settings({"pogo_login": {"url": url}})

    def test_exchange_uses_only_configured_fields_and_refuses_redirects(self):
        settings = {"url": "https://pogo.social/api/test-only", "encoding": "json", "init_data_field": "signed", "token_field": "data.access"}
        class Response:
            status_code = 200
            def json(self):
                return {"data": {"access": "test-token-1234567890"}}
        def post(url, **kwargs):
            self.assertEqual(url, settings["url"])
            self.assertEqual(kwargs["json"], {"signed": "signed-input"})
            self.assertFalse(kwargs["allow_redirects"])
            return Response()
        self.assertEqual(auth.exchange(settings, "signed-input", post), "test-token-1234567890")
        Response.status_code = 302
        with self.assertRaisesRegex(auth.AuthError, "pogo_login_failed"):
            auth.exchange(settings, "signed-input", post)

    def test_native_protocol_roundtrip_and_size_limit(self):
        stream = io.BytesIO()
        auth.write_message(stream, {"action": "status"})
        stream.seek(0)
        self.assertEqual(auth.read_message(stream), {"action": "status"})
        with self.assertRaises(auth.AuthError):
            auth.read_message(io.BytesIO(struct.pack("<I", 99999999)))


class TelegramLaunchTests(unittest.IsolatedAsyncioTestCase):
    async def test_menu_bot_uses_its_advertised_url(self):
        from telethon import functions
        bot = SimpleNamespace(bot_has_main_app=False)
        menu = SimpleNamespace(url="https://pogo.social/app")
        full = SimpleNamespace(full_user=SimpleNamespace(bot_info=SimpleNamespace(menu_button=menu)))
        signed = "auth_date=1900000000&hash=signed"
        client = SimpleNamespace(connect=AsyncMock(), disconnect=AsyncMock(),
            is_user_authorized=AsyncMock(return_value=True), get_entity=AsyncMock(return_value=bot))
        calls = []
        class Client:
            def __getattr__(self, name): return getattr(client, name)
            async def __call__(self, request):
                calls.append(request)
                if isinstance(request, functions.users.GetFullUserRequest): return full
                return SimpleNamespace(url="https://pogo.social/app#tgWebAppData=" + quote(signed, safe=""))
        with patch("telethon.TelegramClient", return_value=Client()), patch.object(auth, "session_path") as path, patch.object(auth, "decrypt_hash", return_value="test"):
            path.return_value.exists.return_value = True
            result = await auth.fresh_init_data({"api_id": 1, "api_hash_dpapi": "test"})
        self.assertEqual(result, signed)
        self.assertIsInstance(calls[-1], functions.messages.RequestWebViewRequest)
        self.assertEqual(calls[-1].url, menu.url)
        self.assertTrue(calls[-1].from_bot_menu)
        client.disconnect.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
