@echo off
cd /d "%~dp0.."
"native-auth\.venv\Scripts\python.exe" "native-auth\setup.py" wizard
echo.
pause
