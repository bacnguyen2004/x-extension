"""Long-poll Telegram commands so /help and /status reply in seconds."""
import atexit
import json
import os
import signal
import time
from pathlib import Path

from pogo_auth import CONFIG_DIR, AuthError, decrypt_hash, load_config
from telegram_ops import (
    ingest_updates,
    load_ops_state,
    send_command_replies,
    with_ops_lock,
    write_live_heartbeat,
)

POLL_TIMEOUT = 25
HTTP_TIMEOUT = 40


def log(message):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + " " + str(message)[:200]
    try:
        with (CONFIG_DIR / "bot-poll.log").open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def stop_other_poller(directory):
    path = directory / "live-poll.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return
    pid = data.get("pid") if isinstance(data, dict) else None
    if type(pid) is not int or pid <= 0 or pid == os.getpid():
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass


def install_startup():
    startup = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    python = Path(__file__).resolve().parent / ".venv" / "Scripts" / "python.exe"
    script = Path(__file__).resolve().parent / "telegram_bot.py"
    if not startup.is_dir() or not python.is_file():
        return False
    launcher = startup / "XContentCreatorTelegramBot.cmd"
    launcher.write_text(f'@echo off\r\nstart "" /MIN "{python}" "{script}"\r\n', encoding="utf-8")
    return True


def bot_call(post, token, method, payload, timeout=10):
    response = post(
        f"https://api.telegram.org/bot{token}/{method}",
        json=payload,
        timeout=timeout,
        allow_redirects=False,
    )
    try:
        body = response.json()
    except ValueError:
        raise AuthError("bot_request_failed") from None
    if response.status_code != 200 or body.get("ok") is not True:
        raise AuthError("bot_request_failed")
    return body


def poll_once(config, post, directory, now, timeout=POLL_TIMEOUT):
    settings = config.get("telegram_notifications") or {}
    if not settings.get("enabled") or settings.get("commands_enabled") is not True:
        return {"ok": True, "skipped": True}
    token = decrypt_hash(settings.get("bot_token_dpapi", ""))
    chat = str(settings.get("chat_id", ""))
    write_live_heartbeat(directory, now)

    def read_offset():
        state, _path = load_ops_state(directory)
        return state.get("offset", 0)

    held = with_ops_lock(directory, read_offset)
    if isinstance(held, dict) and held.get("busy"):
        return {"ok": True, "busy": True}
    offset = held if type(held) is int else 0
    updates = bot_call(post, token, "getUpdates", {
        "offset": offset, "timeout": timeout, "limit": 100, "allowed_updates": ["message"],
    }, timeout=timeout + 10).get("result", [])

    def consume():
        state, path = load_ops_state(directory)
        commands = ingest_updates(state, updates, settings, now)
        snapshot = state.get("snapshot") if isinstance(state.get("snapshot"), dict) else {}
        path.write_text(json.dumps(state), encoding="utf-8")
        return commands, snapshot

    consumed = with_ops_lock(directory, consume)
    if isinstance(consumed, dict) and consumed.get("busy"):
        return {"ok": True, "busy": True}
    commands, snapshot = consumed
    if commands:
        def sender(method, payload):
            return bot_call(post, token, method, payload)
        send_command_replies(sender, chat, commands, snapshot, now)
    return {"ok": True, "commands": len(commands)}


def run():
    import requests
    directory = CONFIG_DIR
    directory.mkdir(parents=True, exist_ok=True)
    stop_other_poller(directory)
    write_live_heartbeat(directory)
    atexit.register(lambda: log("live poll exit"))
    log("live poll started")
    while True:
        try:
            config = load_config()
            now = int(time.time())
            result = poll_once(config, requests.post, directory, now)
            if result.get("busy"):
                time.sleep(1)
        except KeyboardInterrupt:
            log("live poll stopped")
            return
        except AuthError as error:
            log("live poll retry " + str(error)[:80])
            time.sleep(2)
        except Exception as error:
            log("live poll retry " + type(error).__name__)
            time.sleep(2)


if __name__ == "__main__":
    run()
