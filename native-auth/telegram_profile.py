"""Set bot name, about text, command menu and profile photo."""
import asyncio
from pathlib import Path
from pogo_auth import CONFIG_DIR, AuthError, decrypt_hash
from telegram_ui import BOT_ABOUT, BOT_COMMANDS, BOT_NAME, BOT_SHORT, format_help, menu, payload

AVATAR = Path(__file__).with_name("bot-avatar.jpg")


def apply_bot_profile(config, post=None, avatar=None):
    import requests
    post = post or requests.post
    settings = config.get("telegram_notifications") or {}
    token = decrypt_hash(settings.get("bot_token_dpapi", ""))
    chat = str(settings.get("chat_id", ""))
    result = {"ok": True}

    def bot(method, payload, timeout=20):
        response = post(f"https://api.telegram.org/bot{token}/{method}", json=payload, timeout=timeout, allow_redirects=False)
        body = response.json()
        if response.status_code != 200 or body.get("ok") is not True:
            raise AuthError("bot_profile_failed")
        return body

    bot("setMyName", {"name": BOT_NAME})
    bot("setMyShortDescription", {"short_description": BOT_SHORT})
    bot("setMyDescription", {"description": BOT_ABOUT})
    bot("setMyCommands", {"commands": BOT_COMMANDS})
    if chat:
        bot("setMyCommands", {"commands": BOT_COMMANDS, "scope": {"type": "chat", "chat_id": chat}})
    photo = Path(avatar) if avatar else AVATAR
    if photo.is_file():
        try:
            asyncio.run(upload_bot_photo(config, photo))
            result["photo"] = True
        except Exception:
            result["photo"] = False
            result["photoError"] = "bot_photo_failed"
    if chat:
        bot("sendMessage", {"chat_id": chat, **payload(format_help(), menu())})
        result["preview"] = True
    return result


async def upload_bot_photo(config, photo):
    from telethon import TelegramClient
    from telethon.tl.functions.photos import UploadProfilePhotoRequest
    api_id = config.get("api_id")
    if type(api_id) is not int:
        raise AuthError("telegram_not_configured")
    token = decrypt_hash((config.get("telegram_notifications") or {}).get("bot_token_dpapi", ""))
    session = CONFIG_DIR / "bot-avatar.session"
    client = TelegramClient(str(session), api_id, decrypt_hash(config.get("api_hash_dpapi", "")))
    await client.start(bot_token=token)
    try:
        uploaded = await client.upload_file(str(photo))
        await client(UploadProfilePhotoRequest(file=uploaded))
    finally:
        await client.disconnect()
