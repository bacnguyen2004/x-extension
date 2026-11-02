"""Bot notifications independent of the Telethon login session."""
import re
from html import escape
from pogo_auth import AuthError, decrypt_hash
from telegram_ui import account, valid_account, counters, footer, links, payload, STATES

EVENTS = {
    "test": "Kết nối thông báo Telegram thành công.",
    "agent_started": "Agent đã bắt đầu chạy.",
    "agent_stopped": "Agent đã dừng hoặc tạm dừng. Mở tool để kiểm tra trạng thái.",
    "agent_error": "Agent gặp lỗi liên tiếp. Mở nhật ký tool để kiểm tra.",
    "pogo_auth_error": "Chưa gia hạn được phiên Pogo. Kiểm tra kết nối Telegram trên VPS.",
    "hourly_summary": "Tổng kết hoạt động hôm nay",
    "daily_target_reached": "Agent đã đủ mục tiêu hôm nay. Chế độ 24/24 tự tiếp tục khi sang ngày mới.",
    "pogo_bounty": "Bounty Pogo",
    "pogo_bounty_error": "Không tải được danh sách bounty Pogo. Mở Pogo kiểm tra kèo và phiên đăng nhập ngay.\nhttps://pogo.social/",
}

BOUNTY_KINDS = {
    "new": "Bounty Pogo mới — join được (FCFS)",
    "joined": "Đã join bounty Pogo",
    "blocked": "Bounty Pogo mới — chưa join được",
    "failed": "Join bounty Pogo thất bại",
    "uncertain": "Chưa rõ kết quả join bounty Pogo — kiểm tra ngay trên Pogo",
}

BOUNTY_REASONS = {
    "placement": "Rank chưa đủ",
    "followers": "Chưa đủ follower",
    "followers_unknown": "Chưa đo được follower",
    "ineligible": "Không đủ điều kiện",
    "no_slots": "Hết slot",
    "already_claimed": "Đã join",
    "join_closed": "Đã đóng join",
    "expired": "Đã hết hạn",
    "not_enough_hops": "Không đủ Hops",
    "in_debt": "Đang nợ Hops",
    "wallet_required": "Cần ví payout",
    "join_failed": "Join thất bại",
    "session_expired": "Phiên Pogo hết hạn hoặc không hợp lệ",
    "network_error": "Lỗi mạng hoặc hết thời gian chờ; lệnh join có thể đã được nhận",
    "service_error": "API Pogo lỗi hoặc chưa đọc được điều kiện tài khoản",
}

HEADINGS = {
    "test": "✅ BOT ĐÃ KẾT NỐI", "agent_started": "🟢 AGENT BẮT ĐẦU",
    "agent_stopped": "⏸ AGENT ĐÃ DỪNG", "agent_error": "🔴 AGENT CẦN KIỂM TRA",
    "pogo_auth_error": "🔑 LỖI PHIÊN POGO", "pogo_bounty_error": "⚠️ KHÔNG QUÉT ĐƯỢC BOUNTY",
    "hourly_summary": "📊 CẬP NHẬT HOẠT ĐỘNG", "daily_target_reached": "🎯 ĐỦ MỤC TIÊU HÔM NAY",
}
BOUNTY_ICONS = {"new": "⚡", "joined": "✅", "blocked": "⚠️", "failed": "❌", "uncertain": "❓"}


def notification_payload(message):
    event = message.get("event")
    if event not in EVENTS:
        raise AuthError("notification_event_invalid")
    handle = message.get("account")
    markup = None
    quiet = event in ("hourly_summary", "agent_started", "agent_stopped", "daily_target_reached")
    if event == "pogo_bounty":
        bounty = message.get("bounty") or {}
        if not isinstance(bounty, dict):
            raise AuthError("notification_event_invalid")
        kind, bid = bounty.get("kind"), bounty.get("id")
        if kind not in BOUNTY_KINDS or type(bid) is not int or not 0 < bid <= 100000000:
            raise AuthError("notification_event_invalid")
        title = bounty.get("title")
        title = re.sub(r"[\x00-\x1f]+", " ", title).strip()[:80] if isinstance(title, str) else ""
        text = f"<b>{BOUNTY_ICONS[kind]} {BOUNTY_KINDS[kind]}</b>\n\n<b>{escape(title or 'Bounty Pogo')}</b>\nMã kèo: <code>#{bid}</code>"
        if valid_account(handle):
            text += "\n👤 X: <b>" + escape(account(handle)) + "</b>"
        bits = []
        for key, label, suffix in [("fee", "Phí", " Hops"), ("slots", "Slot còn", "")]:
            value = bounty.get(key)
            if type(value) is int and 0 <= value <= 100000000:
                bits.append(f"{label}: <b>{value:,}{suffix}</b>")
        if bits:
            text += "\n\n" + " · ".join(bits)
        reason = bounty.get("reason")
        if isinstance(reason, str) and reason in BOUNTY_REASONS:
            text += "\nLý do: " + escape(BOUNTY_REASONS[reason])
        if kind in ("blocked", "failed", "uncertain"):
            text += "\n\n<b>👉 Cần bạn kiểm tra</b>\nKiểm tra trạng thái và join tay nếu chưa join."
        text += f"\n\nMở Pogo → Bounties → tìm <code>#{bid}</code>."
        text += footer(message.get("at"))
        markup, quiet = links(handle), kind == "joined"
    else:
        text = "<b>" + HEADINGS[event] + "</b>"
        if valid_account(handle):
            text += "\n👤 X: <b>" + escape(account(handle)) + "</b>"
        if event == "hourly_summary":
            text += "\n\n<b>SỐ LƯỢT HÔM NAY</b>\n" + counters(message.get("stats"))
            state = STATES.get(message.get("status"))
            if state:
                text += "\n\n" + state
        else:
            text += "\n\n" + escape(EVENTS[event].replace("\nhttps://pogo.social/", ""))
        if event in ("pogo_auth_error", "pogo_bounty_error"):
            text += "\n\n👉 Mở Pogo kiểm tra kèo; kiểm tra phiên Telegram/helper trên VPS."
            markup = links(handle)
        elif valid_account(handle):
            markup = links(handle, pogo=False)
        text += footer(message.get("at"))
    return payload(text, markup, quiet)


def send_notification(config, message, post=None):
    settings = config.get("telegram_notifications") or {}
    if not settings.get("enabled"):
        return {"ok": True, "skipped": True}
    chat = str(settings.get("chat_id", ""))
    if not re.fullmatch(r"-?[1-9][0-9]*", chat):
        raise AuthError("notification_chat_missing")
    event = message.get("event")
    if event not in EVENTS:
        raise AuthError("notification_event_invalid")
    token = decrypt_hash(settings.get("bot_token_dpapi", ""))
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
        raise AuthError("notification_bot_invalid")
    body = notification_payload(message)
    if post is None:
        import requests
        post = requests.post
    try:
        response = post("https://api.telegram.org/bot" + token + "/sendMessage",
            json={"chat_id": chat, **body}, timeout=15, allow_redirects=False)
        if response.status_code != 200 or response.json().get("ok") is not True:
            raise AuthError("notification_send_failed")
    except AuthError:
        raise
    except Exception:
        # Request errors can contain the Bot Token in the URL.
        raise AuthError("notification_send_failed") from None
    return {"ok": True}
