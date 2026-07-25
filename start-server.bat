@echo off
rem Double-click launcher: starts the Vortex Collection Tools web server and opens a browser tab
rem automatically (web/server.js does the browser-open itself, unless autoOpenBrowser is turned off
rem in Settings). Window stays open after the server exits/crashes so any error output stays
rem readable instead of flashing shut.
rem
rem Works two ways:
rem   - Self-contained release zip: uses the bundled node\node.exe and pre-installed node_modules --
rem     nothing to install, just double-click.
rem   - Plain git clone: falls back to whatever "node" is on PATH, and runs npm install once if
rem     node_modules is missing.
setlocal
cd /d "%~dp0"

if exist "node\node.exe" (
    set "NODE_EXE=%~dp0node\node.exe"
    set "NPM_CMD=%~dp0node\npm.cmd"
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo Node.js was not found on PATH.
        echo Install it from https://nodejs.org/ ^(the LTS version^) and run this again.
        pause
        exit /b 1
    )
    set "NODE_EXE=node"
    set "NPM_CMD=npm"
)

if not exist "node_modules" (
    echo First run: installing dependencies...
    call "%NPM_CMD%" install
    if errorlevel 1 (
        echo npm install failed -- see the errors above.
        pause
        exit /b 1
    )
)

echo Starting Vortex Collection Tools...
"%NODE_EXE%" web\server.js
echo.
echo Server stopped.
pause
