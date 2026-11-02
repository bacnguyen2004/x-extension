# Local Pogo authentication

### Telegram presentation update (1.0.80)

Keep `telegram_ui.py`, `telegram_notify.py` and `telegram_ops.py` together when updating another VPS. Notifications now use escaped HTML, fixed Pogo/X URL buttons and Vietnam timestamps; retried Bounty alerts retain their original event time. New/failed/blocked/uncertain Bounty notices notify normally, while success notices and routine reports are silent. With bot commands enabled, `/start` or `/help` opens the persistent Status / Today / Help keyboard; `/today` returns the current day's counters. These remain read-only commands with the existing chat/user authorization. Existing bot credentials need no change. Setup-Monitoring also registers `/today` for newly configured bots.

This helper is separate from the extension's X automation. It uses a locally authorized Telethon session to obtain fresh Telegram launch data and exchange it through Pogo's actual login endpoint. It does not scrape an open app or automate Telegram Web.

Current setup: the Telegram application credentials are stored under `%LOCALAPPDATA%\XContentCreator\pogo-auth\config.json`. The API hash is encrypted for the current Windows user with DPAPI. The Telegram session and this config stay outside the repository.

Verified on 2026-10-24 against Pogo's published app and a live successful exchange: `POST https://pogo.social/api/auth/session`, JSON `{ "init_data": "<signed Telegram data>" }`, response field `token`. The resulting Bearer was accepted by `/api/feed` (HTTP 200). These settings are configured locally. The helper does not contact Telegram if the login configuration is absent.

The bot currently exposes a menu URL rather than a Main App. The helper reads the bot metadata and uses `messages.requestWebView` for that menu; it uses `messages.requestMainWebView` only when the bot advertises a Main App. Neither path requests a new phone login when the saved session remains authorized.

From `C:\Build X\x-extension`:

For a new Windows computer or VPS, install Python 3.10+ and Chrome, copy the project, then run `Setup-VPS.cmd` as the same Windows user that runs Chrome. It recreates the Python environment, prompts locally for Telegram API ID/hash, encrypts the hash for that Windows account, configures the verified Pogo login endpoint, and starts the extension/session wizard. Enter the extension ID from Chrome on the VPS and the session path on the VPS. Existing `.venv` and DPAPI-encrypted config are not portable credentials. The setup does not send credentials to the chat. Reload the unpacked extension from `dist` and check the Telegram connection after setup.

If `telegram.local.json` exists beside `setup.py`, setup reads its `api_id` and `api_hash` without prompting, then encrypts them for the destination Windows user. This file contains the application credentials in plain text and is ignored by Git. Copy it only with your private project. When exactly one `.session` exists under `native-auth/sessions`, the wizard selects it automatically. The Chrome extension ID still comes from the destination computer.

For the interactive setup, double-click `Setup-Pogo-Auth.cmd`. It asks for the extension ID and either an existing Telethon session path or a new local login. This setup does not discover Pogo's unknown login endpoint.

```powershell
# Create a new session: enter phone, OTP and 2FA locally.
.\native-auth\.venv\Scripts\python.exe native-auth/setup.py login

# Or use an existing compatible Telethon session (not a Pyrogram session).
.\native-auth\.venv\Scripts\python.exe native-auth/setup.py set-session "C:\path\account.session"

# Register the native host for the extension ID shown in chrome://extensions.
.\native-auth\.venv\Scripts\python.exe native-auth/setup.py install EXTENSION_ID

# Status never prints credentials or token contents.
.\native-auth\.venv\Scripts\python.exe native-auth/setup.py status
```

Configure `pogo_login` in the local config only after inspecting Pogo's real login request:

- `url`: exact HTTPS API URL on `pogo.social` (no query credentials).
- `encoding`: `json` or `form`.
- `init_data_field`: actual payload field that carries Telegram initData.
- `token_field`: actual token response field, with dotted paths supported.
- `extra_payload`: other verified, non-secret fields if needed.

Then reload the extension and enable **Tự cấp Bearer qua phiên Telegram trên máy** under Sources. The extension validates the returned token with `/api/feed` and checks the linked X identity before accepting it. Renewal preserves queued work for the same account. It checks the JWT expiry every minute and renews within five minutes of expiry; failed attempts have a one-minute cooldown. Entering a manual Bearer disables automatic mode.

If Telegram revokes the session, log in locally again. A valid Telegram session and the correct Pogo login request are prerequisites; the API ID/hash alone do not constitute a logged-in account.

## Bot notifications

### Status commands, daily reports and external monitoring

After updating both `dist` and the helper's `.py` files on the VPS, run `Setup-Telegram-Bot.cmd` under the Windows account that runs Chrome. It sets the bot name/about/avatar, starts a live long-poller, and registers a logon task `XContentCreatorTelegramBot`. Commands reply in a few seconds while that process is running. Chrome telemetry still refreshes `/status` data about once a minute and skips `getUpdates` so the two paths do not steal updates. If the live poller stops, the one-minute Chrome alarm is the fallback. Only one computer may poll a bot. Commands are read-only: `/status` cannot start/stop the Agent. Requests older than five minutes are ignored. In a group, setup additionally requires explicit permitted sender IDs; being a group member alone does not authorize status access.

Run `Setup-Monitoring.cmd` for Healthchecks and daily reports. It reuses the saved Bot Token/Chat ID.

Daily reports are sent after midnight in `Asia/Ho_Chi_Minh`, or on the next startup if Chrome was closed. Counts accumulate across manual counter resets and reports retain seven completed days for catch-up. Pogo receipts count unique tool jobs explicitly confirmed by Pogo, separately from executed actions; they are not points or payment totals. Rest time is observed scheduled waiting, excludes long offline gaps, and is split at Vietnam midnight. Errors and warnings are counted from tool log entries. A report is acknowledged only after the helper confirms Telegram delivery; the helper also keeps delivery IDs across extension reloads.

The outage receiver is external to the VPS. Default supported service: [Healthchecks.io](https://healthchecks.io/docs/http_api/). Create a check with a **5-minute period and 5-minute grace**, configure its [Telegram integration](https://healthchecks.io/integrations/telegram/), then paste its private `https://hc-ping.com/<uuid>` Ping URL in `Setup-Monitoring.cmd`. Enter skips this step if no receiver exists yet. No Bot Token or Pogo credentials are sent to Healthchecks; the heartbeat is an empty request. Healthchecks' built-in Telegram integration uses HealthchecksBot, separately from your status bot.

The native helper sends a success ping every five minutes while the extension responds, including scheduled rest and intentional manual pause. An active Agent whose work deadline is overdue by ten minutes emits `/fail`. Closing Chrome, shutting down the VPS, or a stuck worker stops pings so the external service can alert. Outage alerts remain **unavailable until the Ping URL and the external notification integration are configured**. Disable command polling with `telegram_notifications.commands_enabled=false` or heartbeat delivery with `healthchecks.enabled=false` in the local config. These settings do not stop the Agent.

Run `Setup-Telegram-Notifications.cmd` on the Windows computer that runs Chrome. It imports `telegram-bot.local.json` if present (private Bot Token and numeric Chat ID), or prompts for those values. The installer encrypts the Bot Token for that Windows user and sends a test message. The bot must already have received `/start` in a private chat, or be a member of the destination group with permission to send. Bot delivery uses the official Telegram Bot API and does not depend on the Telethon user session.

The extension sends start/stop/error alerts, Pogo renewal and bounty-list failures, a daily-goal alert, hourly summaries while running/waiting, and Pogo bounty alerts. On discovery it starts the bot send **before** the join POST and never waits for Telegram's response. Each claim sends its own success, failure or uncertain-result alert, with a fixed Pogo link and bounty ID for manual checking. Free bounties without wallet requirements do not wait for `/api/me`. Bounty polling runs every 30 seconds on Chrome 120+ (alarms may be delayed by Chrome). Failed bounty notices stay in extension local storage for up to 24 hours and retry on later polls, even after worker reload; successful notices are deduplicated by account, bounty, event and reason. Other alerts are throttled for 15 minutes, daily-goal alerts once per Vietnam calendar day, and summaries once per hour. Only fixed event messages, bounty metadata, account handles and action counters are transmitted; raw logs, JWTs and Telegram launch credentials are not forwarded. Notification failures do not stop Auto Join. A stopped browser or VPS cannot send its own outage alert. Update this folder's `telegram_notify.py` together with the extension so the helper understands the new events. To disable delivery, set `telegram_notifications.enabled` to `false` in the local encrypted-credential config. Portable `telegram-bot.local.json` contains plaintext credentials and is ignored by Git; keep it private.
