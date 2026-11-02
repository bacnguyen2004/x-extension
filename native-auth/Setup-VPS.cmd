@echo off
cd /d "%~dp0.."
echo Set up Pogo authentication on this Windows computer.
where py >nul 2>nul
if errorlevel 1 (
  python -m venv native-auth\.venv
) else (
  py -3 -m venv native-auth\.venv
)
if errorlevel 1 goto failed
"native-auth\.venv\Scripts\python.exe" -m pip install -r native-auth\requirements.txt
if errorlevel 1 goto failed
"native-auth\.venv\Scripts\python.exe" native-auth\setup.py configure
if errorlevel 1 goto failed
"native-auth\.venv\Scripts\python.exe" native-auth\setup.py wizard
if errorlevel 1 goto failed
echo Setup finished. Reload the extension in Chrome on this computer.
pause
exit /b 0
:failed
echo Setup failed. Check the message above. Python 3.10 or later is required.
pause
exit /b 1
