@echo off
rem Double-click launcher: starts the Vortex Collection Tools web server and opens a browser tab
rem automatically (web/server.js does the browser-open itself, unless autoOpenBrowser is turned off
rem in Settings). Window stays open after the server exits/crashes so any error output stays
rem readable instead of flashing shut.
rem
rem Works two ways:
rem   - Self-contained release zip: uses the bundled node\node.exe and pre-installed node_modules --
rem     nothing to install, just double-click. (No bundled npm -- node_modules already has
rem     everything needed, and npm/npx/corepack would just be dead weight in the zip.)
rem   - Plain git clone: falls back to whatever "node"/"npm" is on PATH, and runs npm install once
rem     if node_modules is missing.
setlocal
cd /d "%~dp0"

if exist "node\node.exe" (
    set "NODE_EXE=%~dp0node\node.exe"
    set "USING_BUNDLED_NODE=1"
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo Node.js was not found on PATH.
        echo Install it from https://nodejs.org/ ^(the LTS version^) and run this again.
        pause
        exit /b 1
    )
    set "NODE_EXE=node"
)

if not exist "node_modules" (
    if defined USING_BUNDLED_NODE (
        echo node_modules is missing from this release -- it should have shipped pre-installed.
        echo Try re-downloading the release zip instead of running npm install here.
        pause
        exit /b 1
    )
    echo First run: installing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed -- see the errors above.
        pause
        exit /b 1
    )
)

echo ======================================================================
echo  Keep this window open while you use the app in your browser.
echo  To stop the server when you're done, do ANY of these:
echo    - Press Ctrl+C in this window
echo    - Click the X to close this window
echo    - Run stop.bat (from anywhere)
echo  All three shut it down the same safe way.
echo ======================================================================
echo.

echo Starting Vortex Collection Tools...
"%NODE_EXE%" web\server.js
echo.
echo Server stopped.
pause
