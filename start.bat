@echo off
rem Double-click to start Job Autopilot (API + worker + dashboard). Close this window to stop it.
cd /d "%~dp0"
title Job Autopilot
echo Starting Job Autopilot...
echo Dashboard will open at http://localhost:5173 in a few seconds.
echo Keep this window open. Closing it stops job fetching, scoring and the daily digest.
echo.
start "" cmd /c "timeout /t 12 >nul & start http://localhost:5173"
call npm run dev
echo.
echo Job Autopilot stopped.
pause
