@echo off
cd /d "%~dp0.."
"native-auth\.venv\Scripts\python.exe" native-auth\setup.py live-bot
if errorlevel 1 goto failed
start "XContentCreatorTelegramBot" /MIN "native-auth\.venv\Scripts\python.exe" "native-auth\telegram_bot.py"
echo Reload Chrome if the extension is open. Tap Hướng dẫn in Telegram to test.
pause
exit /b 0
:failed
echo Live bot setup failed. Check the message above.
pause
exit /b 1
