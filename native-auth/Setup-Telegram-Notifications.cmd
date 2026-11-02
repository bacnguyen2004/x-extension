@echo off
cd /d "%~dp0.."
"native-auth\.venv\Scripts\python.exe" native-auth\setup.py configure-bot
if errorlevel 1 goto failed
"native-auth\.venv\Scripts\python.exe" native-auth\setup.py test-bot
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Notification setup failed. Check the message above.
pause
exit /b 1
