@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Presentation Export bridge

rem  Double-click this to start the bridge on Windows. Nothing to remember,
rem  nothing to type. This is the Windows equivalent of "Start Bridge.command";
rem  only one of the two ever runs on a given machine. (Same approach as the
rem  Design System Documentation plugin's "Start Claude bridge.cmd" — ported
rem  here for this bridge.)

cd /d "%~dp0"

set "PORT=%PRESENTATION_BRIDGE_PORT%"
if not defined PORT set "PORT=3001"

if not exist "bridge\server.mjs" (
  echo Can't find bridge\server.mjs next to this shortcut.
  echo Expected it in: %~dp0bridge
  echo.
  echo Keep this file in the plugin folder.
  echo.
  pause
  exit /b 1
)

rem  --- Find node -------------------------------------------------------------
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE (
  echo Node isn't installed, or isn't on the PATH this window can see.
  echo.
  echo Install it from https://nodejs.org  ^(the LTS build is fine^), then try again.
  echo.
  pause
  exit /b 1
)

rem  --- Is the port already taken? --------------------------------------------
rem  A bridge left running from an earlier session holds the port and the new
rem  one silently never binds. Name it and offer to stop it.
set "HOLDER="
for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not defined HOLDER set "HOLDER=%%p"
)
if defined HOLDER (
  echo Something is already listening on port %PORT%  ^(process id !HOLDER!^).
  echo That is probably the bridge you want - the plugin's warning banner
  echo should already have cleared.
  echo.
  choice /c YN /n /m "Stop it and start fresh? [Y/N] "
  if errorlevel 2 (
    echo Leaving it alone.
    echo.
    pause
    exit /b 0
  )
  taskkill /pid !HOLDER! /f >nul 2>&1
  timeout /t 1 /nobreak >nul
  echo.
)

echo Starting the Presentation Export bridge on port %PORT%.
echo Leave this window open while you publish from Figma. Press Ctrl-C to stop it.
echo ----------------------------------------------------------------
echo.

node "bridge\server.mjs"
set "STATUS=%ERRORLEVEL%"

echo.
if "%STATUS%"=="0" (
  echo Bridge stopped.
) else (
  echo Bridge exited unexpectedly - code %STATUS%. The messages above say why.
)
echo.
pause
exit /b %STATUS%
