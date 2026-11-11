@echo off
setlocal EnableExtensions
rem ===========================================================================
rem  AppWatch - deploy / update on Cloudflare (Workers + D1 + Cron, free tier)
rem
rem    deploy.bat                    first deploy, or update an existing install
rem    deploy.bat --reset-password   change the dashboard admin password
rem    deploy.bat --help             show options
rem
rem  Requirements: Node.js 22.12+ (https://nodejs.org) and a free Cloudflare
rem  account. Everything else (Wrangler, the D1 database, migrations, the Cron
rem  Trigger, secrets) is installed and configured by this script.
rem ===========================================================================

cd /d "%~dp0"
chcp 65001 >nul 2>&1
title AppWatch deploy

set "PAUSE_AT_END=1"
for %%A in (%*) do if /i "%%~A"=="--no-pause" set "PAUSE_AT_END="
if defined CI set "PAUSE_AT_END="

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [x] Node.js was not found.
  echo       Install Node.js 22 LTS or newer from https://nodejs.org and run deploy.bat again.
  goto :fail
)

set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%V in ('node -v') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 22 (
  echo.
  echo   [x] Node.js 22.12 or newer is required. Installed version:
  node -v
  echo       Download the LTS version from https://nodejs.org
  goto :fail
)

echo.
echo   Installing / updating dependencies ...
call npm install --no-fund --no-audit --loglevel=error
if errorlevel 1 (
  echo   [x] npm install failed. Check your internet connection and try again.
  goto :fail
)

node scripts\deploy.mjs %*
if errorlevel 1 goto :fail

if defined PAUSE_AT_END pause
endlocal
exit /b 0

:fail
echo.
echo   Deployment did not complete. Read the messages above, fix the issue and run deploy.bat again.
if defined PAUSE_AT_END pause
endlocal
exit /b 1
