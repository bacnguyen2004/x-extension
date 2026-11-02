"""Read-only bot commands, daily reports and external liveness signals."""
import json
import hashlib
import os
import re
import time
from urllib.parse import urlsplit
from uuid import UUID
from pogo_auth import CONFIG_DIR, decrypt_hash, AuthError

from telegram_ui import (format_status, format_daily, format_today, format_help, MENU_LABELS, BOT_COMMANDS, menu, links, payload)

SNAPSHOT_FIELDS = ("account", "status", "killSwitch", "connected", "resumeAt", "restReason", "pogoReady", "counters", "rtRemaining", "pendingReceipts", "healthy", "externalHeartbeatConfigured")
LIVE_STALE = 45
LIVE_FILE = "live-poll.json"


def authorized_command(update, settings, now):
    msg = update.get("message") or {}
    sender, chat = msg.get("from") or {}, msg.get("chat") or {}
    if sender.get("is_bot") or str(chat.get("id")) != str(settings.get("chat_id")):
        return None
    allowed = settings.get("allowed_user_ids") or []
    if chat.get("type") == "private":
        if str(sender.get("id")) != str(settings.get("chat_id")): return None
    elif str(sender.get("id")) not in {str(v) for v in allowed}:
        return None
    if type(msg.get("date")) is not int or not 0 <= now - msg["date"] <= 300:
        return None
    text = msg.get("text")
    if not isinstance(text, str): return None
    command = MENU_LABELS.get(text.strip())
    if command is None:
        command = text.strip().split(maxsplit=1)[0] if text.strip() else ""
    if "@" in command:
        command, name = command.split("@", 1)
        if name.lower() != str(settings.get("bot_username", "")).lower(): return None
    return command if command in ["/status", "/today", "/help", "/start"] else None


def sanitize_snapshot(snapshot):
    if not isinstance(snapshot, dict):
        return {}
    clean = {key: snapshot[key] for key in SNAPSHOT_FIELDS if key in snapshot}
    counters = clean.get("counters")
    if isinstance(counters, dict):
        clean["counters"] = {key: counters[key] for key in ("reply", "follow", "retweet", "like", "quote") if key in counters}
    return clean


def pid_alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def live_poll_path(directory):
    return directory / LIVE_FILE


def write_live_heartbeat(directory, now=None):
    now = int(time.time()) if now is None else now
    live_poll_path(directory).write_text(json.dumps({"pid": os.getpid(), "heartbeat_at": now}), encoding="utf-8")


def live_poller_alive(directory, now):
    try:
        data = json.loads(live_poll_path(directory).read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    heartbeat = data.get("heartbeat_at")
    if type(heartbeat) is not int or now - heartbeat > LIVE_STALE:
        return False
    return pid_alive(data.get("pid"))


def command_payload(command, snapshot, now):
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    if command == "/status":
        if not snapshot:
            return payload("<b>📊 TRẠNG THÁI TOOL</b>\nChưa nhận dữ liệu từ extension.\nMở Chrome trên VPS rồi thử lại.", menu())
        return payload(format_status(snapshot, now), links(snapshot.get("account")))
    if command == "/today":
        return payload(format_today(snapshot, now), links(snapshot.get("account")))
    return payload(format_help(now), menu())


def ingest_updates(state, updates, settings, now):
    commands = []
    for update in updates:
        update_id = update.get("update_id")
        if type(update_id) is not int or update_id < state.get("offset", 0):
            continue
        state["offset"] = update_id + 1
        command = authorized_command(update, settings, now)
        if command:
            commands.append(command)
    return list(dict.fromkeys(commands))[-2:]


def send_command_replies(bot, chat, commands, snapshot, now):
    for command in commands:
        bot("sendMessage", {"chat_id": chat, **command_payload(command, snapshot, now)})


def heartbeat_url(config):
    health = config.get("healthchecks") or {}
    if not health.get("enabled"): return None
    url = decrypt_hash(health.get("url_dpapi", ""))
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "hc-ping.com" or parsed.query or parsed.fragment:
        raise AuthError("heartbeat_url_invalid")
    try:
        if str(UUID(parsed.path.strip("/"))) != parsed.path.strip("/").lower(): raise ValueError()
    except ValueError:
        raise AuthError("heartbeat_url_invalid") from None
    return url.rstrip("/")


def with_ops_lock(directory, fn):
    import msvcrt
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "ops.lock").open("a+b") as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return {"ok": True, "busy": True}
        try:
            return fn()
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def load_ops_state(directory):
    path = directory / "ops-state.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        state = {}
    return state if isinstance(state, dict) else {}, path


def process_telemetry(config, message, post=None, get=None, state_dir=None, now=None):
    import requests
    post, get = post or requests.post, get or requests.get
    now = int(time.time()) if now is None else now
    directory = state_dir or CONFIG_DIR
    def run():
        return _process(config, message, post, get, directory, now)
    return with_ops_lock(directory, run)


def _process(config, message, post, get, directory, now):
    snapshot = dict(message["snapshot"]) if isinstance(message.get("snapshot"), dict) else {}
    settings = config.get("telegram_notifications") or {}
    path = directory / "ops-state.json"
    try: state = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError): state = {}
    if not isinstance(state, dict): state = {}
    result = {"ok": True, "reported": [], "commands": 0, "heartbeatConfigured": False}
    try:
        url = heartbeat_url(config)
        result["heartbeatConfigured"] = bool(url)
        snapshot["externalHeartbeatConfigured"] = bool(url)
        healthy = snapshot.get("healthy") is True
        if url and (now - state.get("heartbeat_at", 0) >= 300 or state.get("healthy") != healthy):
            response = get(url + ("" if healthy else "/fail"), timeout=8, allow_redirects=False)
            if response.status_code == 200 and response.text.strip() == "OK":
                state.update(heartbeat_at=now, healthy=healthy)
                result["heartbeatSent"] = True
    except Exception:
        result["heartbeatError"] = "heartbeat_failed"
    if not settings.get("enabled"):
        path.write_text(json.dumps(state), encoding="utf-8")
        return result
    token = decrypt_hash(settings.get("bot_token_dpapi", ""))
    chat = str(settings.get("chat_id", ""))
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token) or not re.fullmatch(r"-?[1-9][0-9]*", chat):
        raise AuthError("notification_bot_invalid")
    identity = token.split(":", 1)[0] + ":" + chat
    if state.get("bot_identity") != identity:
        state.update(bot_identity=identity, offset=0, reports=[])
    state["snapshot"] = sanitize_snapshot(snapshot)
    state["snapshot_at"] = now
    def bot(method, payload):
        response = post(f"https://api.telegram.org/bot{token}/{method}", json=payload, timeout=10, allow_redirects=False)
        body = response.json()
        if response.status_code != 200 or body.get("ok") is not True: raise AuthError("bot_request_failed")
        return body
    live = live_poller_alive(directory, now)
    result["livePoll"] = live
    if settings.get("commands_enabled") is True and not live:
        # Telegram's slash suggestions are a server-side registry, independent
        # of the handler and the reply keyboard. Sync once per bot/chat/version.
        signature = hashlib.sha256(json.dumps(BOT_COMMANDS, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        registration = {"identity": identity, "signature": signature}
        if state.get("commands_registration") != registration:
            try:
                registered = bot("setMyCommands", {"commands": BOT_COMMANDS, "scope": {"type": "chat", "chat_id": chat}})
                if registered.get("result") is not True:
                    raise AuthError("bot_menu_registration_failed")
                state["commands_registration"] = registration
                path.write_text(json.dumps(state), encoding="utf-8")
                result["menuRegistered"] = True
            except Exception:
                # Retry next poll; a registration outage must not block commands.
                result["menuError"] = "bot_menu_registration_failed"
        try:
            updates = bot("getUpdates", {"offset": state.get("offset", 0), "timeout": 0, "limit": 100, "allowed_updates": ["message"]}).get("result", [])
            commands = ingest_updates(state, updates, settings, now)
            # Persist consumed updates before replying; stale requests never replay after restart.
            path.write_text(json.dumps(state), encoding="utf-8")
            send_command_replies(bot, chat, commands, snapshot, now)
            result["commands"] = len(commands)
        except Exception:
            result["commandError"] = "bot_commands_failed"
    reports = message.get("reports") if isinstance(message.get("reports"), list) else []
    for report in reports[:1]:
        if not isinstance(report, dict): continue
        rid = report.get("id", "")
        if not isinstance(rid, str) or not re.fullmatch(r"[a-z0-9_]{1,15}:\d{4}-\d{2}-\d{2}", rid): continue
        sent = state.get("reports", [])
        try:
            if rid not in sent:
                bot("sendMessage", {"chat_id": chat, **payload(format_daily(report), links(report.get("account")))})
                state["reports"] = (sent + [rid])[-128:]
            result["reported"].append(rid)
        except Exception:
            result["reportError"] = "daily_report_failed"
    path.write_text(json.dumps(state), encoding="utf-8")
    return result
