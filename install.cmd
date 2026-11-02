@echo off
rem Double-click to install or update Access Web. No admin rights needed.
rem Uses install.ps1 next to this file, or downloads it if this file was sent on its own.
setlocal
cd /d "%~dp0"
title Access Web installer
if exist "%~dp0install.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/atmanning/AccessWebApp/main/install.ps1 | iex"
)
echo.
pause
