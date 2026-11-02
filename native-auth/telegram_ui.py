"""Telegram presentation only: escaped HTML and fixed, reviewable destinations."""
import math
import re
import socket
from datetime import datetime, timezone, timedelta
from html import escape
from pogo_auth import AuthError

VN = timezone(timedelta(hours=7))
STATES = {"running": "🟢 Đang chạy", "waiting": "🟡 Đang chờ/nghỉ", "paused": "⏸ Tạm dừng", "error": "🔴 Lỗi", "idle": "⚪ Chưa chạy"}
REASONS = {"Tải cao", "Tải bình thường", "Tải thấp", "Chưa có task phù hợp", "Chờ phục hồi sau lỗi", "Đủ mục tiêu hôm nay", "Chờ phiên Pogo"}
MENU_LABELS = {"📊 Trạng thái": "/status", "📈 Hôm nay": "/today", "❔ Hướng dẫn": "/help"}
BOT_COMMANDS = [
    {"command": "start", "description": "Mở menu chính của bot"},
    {"command": "status", "description": "Xem trạng thái tool và kết nối X/Pogo"},
    {"command": "today", "description": "Xem thống kê hoạt động hôm nay"},
    {"command": "help", "description": "Xem hướng dẫn sử dụng bot"},
]
BOT_NAME = "X Content Creator"
BOT_SHORT = "Agent X, Pogo và bounty FCFS. Trả lời ngay."
BOT_ABOUT = (
    "X Content Creator theo dõi Agent trên VPS, phiên Pogo và bounty FCFS.\n\n"
    "Bấm /start để mở menu. /status trạng thái tool, /today thống kê hôm nay, /help hướng dẫn.\n\n"
    "Bot trả lời ngay khi chương trình poll đang chạy. Start/Stop Agent vẫn trên extension."
)


def integer(value, maximum=100000000):
    return min(maximum, max(0, value)) if type(value) is int else 0


def valid_account(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_]{1,15}", value) else None


def account(value):
    return "@" + value if valid_account(value) else "chưa rõ"


def stamp(milliseconds=None):
    if type(milliseconds) in (int, float) and math.isfinite(milliseconds) and 0 < milliseconds < 10000000000000:
        current = datetime.fromtimestamp(milliseconds / 1000, VN)
    else:
        current = datetime.now(VN)
    return current.strftime("%H:%M:%S · %d/%m/%Y") + " VN"


def footer(value=None):
    return "\n\n<i>🕒 " + stamp(value) + " · X Content Creator</i>"


def counters(data):
    data = data if isinstance(data, dict) else {}
    return "\n".join(f"{label}: <b>{integer(data.get(key)):,}</b>" for key, label in [
        ("reply", "💬 Reply"), ("like", "❤️ Like"), ("retweet", "🔁 RT"), ("follow", "👥 Follow"), ("quote", "✍️ Quote")])


def links(handle=None, pogo=True):
    row = []
    if pogo:
        row.append({"text": "⚡ Mở Pogo", "url": "https://pogo.social/"})
    if valid_account(handle):
        row.append({"text": "👤 Mở tài khoản X", "url": "https://x.com/" + handle})
    return {"inline_keyboard": [row]} if row else None


def menu():
    return {"keyboard": [[{"text": "📊 Trạng thái"}, {"text": "📈 Hôm nay"}], [{"text": "❔ Hướng dẫn"}]],
        "resize_keyboard": True, "is_persistent": True}


def payload(text, markup=None, quiet=True):
    result = {"text": text, "parse_mode": "HTML", "link_preview_options": {"is_disabled": True}, "disable_notification": quiet}
    if markup:
        result["reply_markup"] = markup
    return result


def format_status(snapshot, now=None):
    host = re.sub(r"[^A-Za-z0-9_.-]", "", socket.gethostname())[:50]
    text = "<b>📊 TRẠNG THÁI TOOL</b>\n" + STATES.get(snapshot.get("status"), "⚪ Chưa rõ trạng thái")
    if snapshot.get("killSwitch") is True:
        text += "\n<b>🛑 Dừng khẩn đang bật</b>"
    text += f"\n\n👤 X: <b>{escape(account(snapshot.get('account')))}</b>\n🖥 VPS: <code>{escape(host)}</code>"
    text += "\n\n<b>KẾT NỐI</b>\nTab X: " + ("✅ Đã kết nối" if snapshot.get("connected") is True else "❌ Mất kết nối")
    text += "\nPogo: " + ("✅ Có phiên" if snapshot.get("pogoReady") is True else "⚠️ Cần kiểm tra phiên")
    if snapshot.get("restReason") in REASONS:
        text += "\nLý do chờ: " + escape(snapshot["restReason"])
    resume = snapshot.get("resumeAt")
    if type(resume) in (int, float) and math.isfinite(resume) and 0 < resume < 10000000000000:
        text += "\nLượt tiếp theo: " + datetime.fromtimestamp(resume / 1000, VN).strftime("%H:%M:%S · %d/%m") + " VN"
    text += "\n\n<b>HOẠT ĐỘNG HÔM NAY</b>\n" + counters(snapshot.get("counters"))
    if type(snapshot.get("rtRemaining")) is int:
        text += f"\nRT Pogo còn thưởng: <b>{integer(snapshot['rtRemaining'], 20)}</b>"
    text += f"\nChờ Pogo xác nhận: <b>{integer(snapshot.get('pendingReceipts'))}</b>"
    if snapshot.get("healthy") is False:
        text += "\n\n<b>⚠️ Lịch Agent đã quá hạn hơn 10 phút.</b>\nMở VPS kiểm tra Chrome và extension."
    text += "\nGiám sát bên ngoài: " + ("đã cấu hình" if snapshot.get("externalHeartbeatConfigured") is True else "chưa cấu hình")
    return text + footer(now * 1000 if now is not None else None)


def format_today(snapshot, now=None):
    text = "<b>📈 HOẠT ĐỘNG HÔM NAY</b>\n👤 X: <b>" + escape(account(snapshot.get("account"))) + "</b>"
    text += "\n\n" + counters(snapshot.get("counters"))
    if type(snapshot.get("rtRemaining")) is int:
        text += f"\n\n🔁 RT Pogo còn thưởng: <b>{integer(snapshot['rtRemaining'], 20)}</b>"
    return text + footer(now * 1000 if now is not None else None)


def format_daily(report):
    date = report.get("date", "")
    if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise AuthError("report_invalid")
    return (f"<b>📅 TỔNG KẾT NGÀY {date}</b>\n<i>Theo giờ Việt Nam</i>\n👤 X: <b>{escape(account(report.get('account')))}</b>\n\n"
        + counters(report.get("counters"))
        + f"\n\n✅ Biên nhận Pogo: <b>{integer(report.get('pogoRecorded'))}</b>"
        + f"\n🔴 Lỗi: <b>{integer(report.get('errors'))}</b> · ⚠️ Cảnh báo: <b>{integer(report.get('warnings'))}</b>"
        + f"\n⏳ Thời gian nghỉ ghi nhận: <b>{integer(report.get('restMinutes'), 1440)} phút</b>")


def format_help(now=None):
    return ("<b>🤖 X CONTENT CREATOR</b>\nTheo dõi Agent và săn Bounty từ Telegram."
        "\n\n<b>XEM NHANH</b>\n/status · Trạng thái tool và kết nối\n/today · Thống kê hôm nay\n/help · Mở hướng dẫn và menu"
        "\n\n<b>⚡ BOUNTY FCFS</b>\nPhát hiện kèo → báo bot → tự join → báo kết quả."
        "\nKhi lỗi hoặc chưa rõ kết quả, mở Pogo kiểm tra để join tay nếu cần."
        "\n\n<i>Bot trả lời ngay khi chương trình poll đang chạy trên máy."
        " Chỉ xem trạng thái; Start/Stop thực hiện trên extension.</i>"
        + footer(now * 1000 if now is not None else None))
