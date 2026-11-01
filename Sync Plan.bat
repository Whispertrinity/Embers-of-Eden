@echo off
title Pages of Eden - plan sync
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org then run this again.
  pause
  exit /b 1
)
echo Watching design\Pages of Eden for saves...
echo Leave this window open. Every Save in the codex updates Data\*.md and Data\_live\*.json.
echo.
node tools\codex-sync.mjs --watch --push
echo.
echo Sync stopped.
pause
