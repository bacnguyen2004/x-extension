"""Run locally to log in once and register Chrome's native host."""
import argparse
import asyncio
import json
import re
import sys
import getpass
from pathlib import Path
from pogo_auth import CONFIG_DIR, CONFIG_PATH, HOST, load_config, session_path, decrypt_hash, encrypt_hash, status


def save(config):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")


async def login(config):
    from telethon import TelegramClient
    client = TelegramClient(str(session_path(config)), int(config["api_id"]), decrypt_hash(config["api_hash_dpapi"]))
    try:
        await client.start()  # Phone, OTP and 2FA are entered locally, never in extension/chat.
        print("Telegram session ready.")
    finally:
        await client.disconnect()


def install(config, extension_id):
    import winreg
    if not re.fullmatch("[a-p]{32}", extension_id):
        raise ValueError("Invalid Chrome extension ID")
    origin = f"chrome-extension://{extension_id}/"
    config["allowed_origins"] = [origin]
    save(config)
    launcher = CONFIG_DIR / "host.bat"
    host = Path(__file__).with_name("pogo_auth.py").resolve()
    launcher.write_text(f'@echo off\r\n"{sys.executable}" "{host}" %*\r\n', encoding="utf-8")
    manifest = CONFIG_DIR / "native-host.json"
    manifest.write_text(json.dumps({"name": HOST, "description": "Local Pogo token provider", "path": str(launcher), "type": "stdio", "allowed_origins": [origin]}, indent=2), encoding="utf-8")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Google\Chrome\NativeMessagingHosts\{HOST}") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest))
    print("Chrome native host registered for this extension.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["status", "login", "install", "set-session", "wizard", "configure", "configure-bot", "test-bot", "configure-monitoring", "live-bot"])
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    if args.command == "live-bot":
        from telegram_profile import apply_bot_profile
        from telegram_bot import install_startup, stop_other_poller
        import subprocess
        config = load_config()
        settings = config.get("telegram_notifications") or {}
        if not settings.get("enabled"):
            raise ValueError("Run Setup-Telegram-Notifications.cmd first.")
        settings["commands_enabled"] = True
        config["telegram_notifications"] = settings
        save(config)
        profile = apply_bot_profile(config)
        print("Bot name, about and command menu updated.")
        print("Avatar uploaded." if profile.get("photo") else "Avatar not set via API; upload native-auth\\bot-avatar.jpg in BotFather /setuserpic if needed.")
        root = Path(__file__).resolve().parent
        python = root / ".venv" / "Scripts" / "python.exe"
        script = root / "telegram_bot.py"
        if not python.is_file() or not script.is_file():
            raise RuntimeError("Missing venv python or telegram_bot.py")
        stop_other_poller(CONFIG_DIR)
        task = f'"{python}" "{script}"'
        scheduled = subprocess.run(["schtasks", "/Create", "/TN", "XContentCreatorTelegramBot", "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", task], capture_output=True, text=True)
        flags = (
            getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
        )
        err = CONFIG_DIR / "bot-poll-error.log"
        subprocess.Popen(
            [str(python), str(script)],
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=err.open("ab"),
            close_fds=False,
            creationflags=flags,
        )
        print("Live poller started. /help replies in a few seconds while this Windows user is logged on.")
        if install_startup():
            print("Startup shortcut installed so the poller starts at Windows logon.")
        elif scheduled.returncode != 0:
            print("Logon task not installed. Run Setup-Telegram-Bot.cmd after login if the poller is not running.")
        return
    if args.command == "configure-monitoring":
        import requests
        from telegram_ops import heartbeat_url
        config = load_config()
        settings = config.get("telegram_notifications") or {}
        if not settings.get("enabled"):
            raise ValueError("Run Setup-Telegram-Notifications.cmd first.")
        token = decrypt_hash(settings["bot_token_dpapi"])
        try:
            response = requests.post(f"https://api.telegram.org/bot{token}/getMe", timeout=10, allow_redirects=False).json()
            if response.get("ok") is not True: raise ValueError()
            settings["bot_username"] = response["result"]["username"]
            from telegram_ui import BOT_COMMANDS
            response = requests.post(f"https://api.telegram.org/bot{token}/setMyCommands", json={"commands": BOT_COMMANDS}, timeout=10, allow_redirects=False).json()
            if response.get("ok") is not True: raise ValueError()
        except Exception:
            raise RuntimeError("Cannot verify the bot or register its commands.") from None
        if str(settings.get("chat_id", "")).startswith("-"):
            ids = input("Allowed Telegram user IDs in this group (comma separated): ").strip().split(",")
            if not ids or any(not re.fullmatch(r"[1-9][0-9]*", v.strip()) for v in ids):
                raise ValueError("Group commands require explicit allowed user IDs.")
            settings["allowed_user_ids"] = [v.strip() for v in ids]
        settings["commands_enabled"] = True
        config["telegram_notifications"] = settings
        url = getpass.getpass("Healthchecks Ping URL (hidden; Enter to skip/keep existing): ").strip()
        if url:
            config["healthchecks"] = {"enabled": True, "url_dpapi": encrypt_hash(url)}
            heartbeat_url(config)
        save(config)
        print("Read-only /status enabled. Run commands on ONE computer per bot.")
        print("Daily reports: automatic after Vietnam midnight, or after Chrome starts again.")
        print("External heartbeat configured." if config.get("healthchecks", {}).get("enabled") else "External heartbeat NOT configured yet.")
        return
    if args.command == "configure-bot":
        portable = Path(__file__).with_name("telegram-bot.local.json")
        if portable.is_file():
            values = json.loads(portable.read_text(encoding="utf-8"))
            token, chat = str(values.get("bot_token", "")).strip(), str(values.get("chat_id", "")).strip()
            print("Using bot credentials from telegram-bot.local.json.")
        else:
            token = getpass.getpass("Telegram Bot Token (hidden): ").strip()
            chat = input("Destination Chat ID (number; negative for groups): ").strip()
        if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token) or not re.fullmatch(r"-?[1-9][0-9]*", chat):
            raise ValueError("Invalid Bot Token or Chat ID")
        config = load_config()
        config["telegram_notifications"] = {"enabled": True, "bot_token_dpapi": encrypt_hash(token), "chat_id": chat}
        save(config)
        print("Bot notifications configured for this Windows user.")
        return
    if args.command == "test-bot":
        from telegram_notify import send_notification
        result = send_notification(load_config(), {"event": "test"})
        print("Notifications are disabled." if result.get("skipped") else "Test notification sent.")
        return
    if args.command == "configure":
        local_credentials = Path(__file__).with_name("telegram.local.json")
        if local_credentials.is_file():
            values = json.loads(local_credentials.read_text(encoding="utf-8"))
            api_id = str(values.get("api_id", "")).strip()
            api_hash = str(values.get("api_hash", "")).strip()
            print("Using Telegram application credentials from telegram.local.json.")
        else:
            api_id = input("Telegram API ID: ").strip()
            api_hash = getpass.getpass("Telegram API hash (hidden): ").strip()
        if not api_id.isdecimal() or int(api_id) <= 0 or not re.fullmatch(r"[0-9a-fA-F]{32}", api_hash):
            raise ValueError("Invalid Telegram application credentials")
        config = load_config() if CONFIG_PATH.exists() else {}
        config.update(api_id=int(api_id), api_hash_dpapi=encrypt_hash(api_hash))
        config["pogo_login"] = {"url": "https://pogo.social/api/auth/session", "encoding": "json", "init_data_field": "init_data", "token_field": "token"}
        save(config)
        print("Credentials encrypted for this Windows user. Pogo login configured.")
        return
    config = load_config()
    if args.command == "wizard":
        install(config, input("Extension ID from chrome://extensions: ").strip())
        bundled_sessions = list(Path(__file__).with_name("sessions").glob("*.session"))
        if len(bundled_sessions) == 1:
            existing = str(bundled_sessions[0].resolve())
            print("Using the session in native-auth/sessions.")
        else:
            existing = input("Existing Telethon .session path (Enter to create a new session): ").strip().strip('"')
        if existing:
            path = Path(existing).expanduser().resolve()
            if not path.is_file() or path.suffix != ".session":
                raise ValueError("Session file not found")
            config["session_path"] = str(path)
            save(config)
            print("Existing session configured.")
        else:
            asyncio.run(login(config))
        print("Local Telegram setup complete. Reload the extension and check the Telegram connection.")
    elif args.command == "login":
        asyncio.run(login(config))
    elif args.command == "install":
        install(config, args.value or input("Extension ID (chrome://extensions): ").strip())
    elif args.command == "set-session":
        path = Path(args.value or input("Existing Telethon .session path: ")).expanduser().resolve()
        if not path.is_file() or path.suffix != ".session":
            raise ValueError("Session file not found")
        config["session_path"] = str(path)
        save(config)
        print("Session path configured. Credentials were not printed.")
    else:
        print(json.dumps(status(config)))


if __name__ == "__main__":
    main()
