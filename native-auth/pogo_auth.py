"""Local Telegram authentication. Never print initData, API hashes or Bearers."""
import asyncio
import base64
import ctypes
import json
import os
import struct
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HOST = "com.xcontentcreator.pogo_auth"
CONFIG_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "XContentCreator" / "pogo-auth"
CONFIG_PATH = CONFIG_DIR / "config.json"


class AuthError(Exception):
    pass


def load_config():
    if not CONFIG_PATH.exists():
        raise AuthError("telegram_not_configured")
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def decrypt_hash(encoded):
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    raw = base64.b64decode(encoded)
    buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source, output = Blob(len(raw), buf), Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise AuthError("credentials_unavailable")
    try:
        return ctypes.string_at(output.data, output.size).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(output.data)


def encrypt_hash(value):
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    raw = value.encode("utf-8")
    buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source, output = Blob(len(raw), buf), Blob()
    if not ctypes.windll.crypt32.CryptProtectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise AuthError("credentials_unavailable")
    try:
        return base64.b64encode(ctypes.string_at(output.data, output.size)).decode("ascii")
    finally:
        ctypes.windll.kernel32.LocalFree(output.data)


def session_path(config):
    value = Path(config.get("session_path", str(CONFIG_DIR / "telegram.session"))).expanduser().resolve()
    return value if str(value).endswith(".session") else Path(str(value) + ".session")


def auth_settings(config):
    settings = config.get("pogo_login") or {}
    endpoint = settings.get("url", "")
    parsed = urlsplit(endpoint)
    if not endpoint:
        raise AuthError("pogo_endpoint_not_configured")
    if parsed.scheme != "https" or parsed.netloc != "pogo.social" or not parsed.path.startswith("/api/") or parsed.query or parsed.fragment:
        raise AuthError("invalid_pogo_endpoint")
    if settings.get("encoding", "json") not in ("json", "form") or not settings.get("init_data_field") or not settings.get("token_field"):
        raise AuthError("invalid_pogo_login_config")
    return settings


def extract_init_data(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "pogo.social":
        raise AuthError("unexpected_webapp_origin")
    # Decode the OUTER URL once. The signed inner query must stay unchanged.
    value = parse_qs(parsed.fragment).get("tgWebAppData", [None])[0]
    if not value:
        raise AuthError("telegram_init_data_missing")
    fields = parse_qs(value)
    if not fields.get("hash") or not fields.get("auth_date"):
        raise AuthError("invalid_telegram_init_data")
    return value


async def fresh_init_data(config):
    from telethon import TelegramClient, functions
    path = session_path(config)
    if not path.exists():
        raise AuthError("telegram_login_required")
    client = TelegramClient(str(path), int(config["api_id"]), decrypt_hash(config["api_hash_dpapi"]))
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise AuthError("telegram_login_required")
        bot = await client.get_entity("PogoSocialBot")
        if getattr(bot, "bot_has_main_app", False):
            result = await client(functions.messages.RequestMainWebViewRequest(peer=bot, bot=bot, platform="desktop"))
        else:
            full = await client(functions.users.GetFullUserRequest(bot))
            menu = getattr(getattr(full.full_user, "bot_info", None), "menu_button", None)
            url = getattr(menu, "url", "")
            parsed = urlsplit(url)
            if parsed.scheme != "https" or parsed.netloc != "pogo.social":
                raise AuthError("unexpected_webapp_origin")
            result = await client(functions.messages.RequestWebViewRequest(
                peer=bot, bot=bot, platform="desktop", url=url, from_bot_menu=True))
        return extract_init_data(result.url)
    finally:
        await client.disconnect()


def read_field(body, dotted_path):
    value = body
    for key in dotted_path.split("."):
        if not isinstance(value, dict) or key not in value:
            raise AuthError("pogo_token_missing")
        value = value[key]
    return value


def exchange(settings, init_data, post=None):
    if post is None:
        import requests
        post = requests.post
    payload = dict(settings.get("extra_payload") or {})
    payload[settings["init_data_field"]] = init_data
    response = post(settings["url"], **{settings.get("encoding", "json") == "form" and "data" or "json": payload},
                    headers={"Accept": "application/json"}, timeout=20, allow_redirects=False)
    if response.status_code in (401, 403):
        raise AuthError("pogo_login_rejected")
    if not 200 <= response.status_code < 300:
        raise AuthError("pogo_login_failed")
    try:
        token = read_field(response.json(), settings["token_field"])
    except (ValueError, TypeError):
        raise AuthError("pogo_login_invalid_response") from None
    if not isinstance(token, str) or not 16 <= len(token) <= 8192 or any(c.isspace() for c in token):
        raise AuthError("pogo_token_missing")
    return token


def status(config):
    return {"ok": True, "sessionPresent": session_path(config).exists(), "loginConfigured": bool(config.get("pogo_login", {}).get("url"))}


def handle(message):
    config = load_config()
    if message.get("action") == "status":
        return status(config)
    if message.get("action") == "notify":
        from telegram_notify import send_notification
        return send_notification(config, message)
    if message.get("action") == "telemetry":
        from telegram_ops import process_telemetry
        return process_telemetry(config, message)
    if message.get("action") != "get_token":
        raise AuthError("unknown_action")
    settings = auth_settings(config)  # Do not contact Telegram until the actual endpoint is configured.
    # Serialize clients from different extension processes sharing this SQLite session.
    import msvcrt
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with (CONFIG_DIR / "auth.lock").open("a+b") as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise AuthError("auth_busy") from None
        try:
            init_data = asyncio.run(asyncio.wait_for(fresh_init_data(config), timeout=35))
            return {"ok": True, "token": exchange(settings, init_data)}
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def read_message(stream):
    prefix = stream.read(4)
    if not prefix:
        return None
    if len(prefix) != 4:
        raise AuthError("invalid_message")
    length = struct.unpack("<I", prefix)[0]
    if not 0 < length <= 65536:
        raise AuthError("invalid_message")
    data = stream.read(length)
    if len(data) != length:
        raise AuthError("invalid_message")
    message = json.loads(data.decode("utf-8"))
    if not isinstance(message, dict):
        raise AuthError("invalid_message")
    return message


def write_message(stream, payload):
    data = json.dumps(payload).encode("utf-8")
    stream.write(struct.pack("<I", len(data)) + data)
    stream.flush()


def native_main():
    try:
        config = load_config()
        origin = sys.argv[1] if len(sys.argv) > 1 else ""
        if origin not in config.get("allowed_origins", []):
            raise AuthError("unauthorized_extension")
        message = read_message(sys.stdin.buffer)
        if message is None:
            return
        result = handle(message)
    except AuthError as error:
        result = {"ok": False, "error": str(error)}
    except ImportError:
        result = {"ok": False, "error": "dependencies_missing"}
    except Exception:
        # Exceptions may contain signed URLs, phone numbers or server response bodies.
        result = {"ok": False, "error": "telegram_or_pogo_unavailable"}
    write_message(sys.stdout.buffer, result)


if __name__ == "__main__":
    native_main()
