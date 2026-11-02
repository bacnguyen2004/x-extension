@echo off
cd /d "%~dp0.."
"native-auth\.venv\Scripts\python.exe" native-auth\setup.py configure-monitoring
if errorlevel 1 goto failed
echo Reload the extension in Chrome. /status replies within about one minute.
pause
exit /b 0
:failed
echo Monitoring setup failed. Check the message above.
pause
exit /b 1
