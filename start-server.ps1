# The launcher -- start-server.bat is a thin double-click wrapper that just runs this (same
# relationship stop.bat already has to stop.ps1), so there is exactly one copy of the actual
# start-up logic to keep correct. This used to be two separate, hand-duplicated implementations
# (one per file); GitHub issue #4's fix needed a real config.json read + an HTTP check added here,
# and duplicating that a second time in raw batch (which is bad at both JSON and HTTP) was exactly
# the kind of drift that produces subtle, hard-to-notice bugs -- see stop.ps1's OWN pre-fix bug as a
# real example: it was reading config.json from the wrong path (repo root, not config\) and silently
# falling back to the default port on every run, for every user who'd ever changed their port.
#
# Works two ways:
#   - Self-contained release zip: uses the bundled node\node.exe and pre-installed node_modules --
#     nothing to install, just run this. (No bundled npm -- node_modules already has everything
#     needed, and npm/npx/corepack would just be dead weight in the zip.)
#   - Plain git clone: falls back to whatever "node"/"npm" is on PATH, and runs npm install once
#     if node_modules is missing.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$bundledNode = Join-Path $PSScriptRoot "node\node.exe"
$usingBundledNode = Test-Path $bundledNode
if ($usingBundledNode) {
    $nodeExe = $bundledNode
} else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js was not found on PATH."
        Write-Host "Install it from https://nodejs.org/ (the LTS version) and run this again."
        Read-Host "Press Enter to exit"
        exit 1
    }
    $nodeExe = "node"
}

if (-not (Test-Path "node_modules")) {
    if ($usingBundledNode) {
        Write-Host "node_modules is missing from this release -- it should have shipped pre-installed."
        Write-Host "Try re-downloading the release zip instead of running npm install here."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "First run: installing dependencies..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed -- see the errors above."
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# Check whether a server is ALREADY responding on the configured host/port before starting a
# second one (GitHub issue #4: a tester ended up with a duplicate/orphaned server and an
# unreachable Vortex because nothing here checked first). Read config.json the same way stop.ps1
# does -- the real file lives at config\config.json, not a root-level config.json.
$port = 4321
$hostName = "127.0.0.1"
$configPath = Join-Path $PSScriptRoot "config\config.json"
if (Test-Path $configPath) {
    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.serverPort) { $port = $config.serverPort }
        if ($config.serverHost) { $hostName = $config.serverHost }
    } catch {
        Write-Host "Could not read config.json -- falling back to the default port ($port)." -ForegroundColor Yellow
    }
}
# "0.0.0.0" is a bind address ("all interfaces"), not something a client can connect to -- use the
# loopback address instead in that case, same as web/server.js's own isLoopback/browseUrl handling.
if ($hostName -eq "0.0.0.0") { $hostName = "127.0.0.1" }

$serverAlreadyRunning = $false
try {
    Invoke-RestMethod -Uri "http://${hostName}:$port/api/settings" -Method Get -TimeoutSec 3 | Out-Null
    $serverAlreadyRunning = $true
} catch {
    $serverAlreadyRunning = $false
}

if ($serverAlreadyRunning) {
    $trayRunning = $null -ne (Get-Process -Name "VortexCollectionTools" -ErrorAction SilentlyContinue)
    Write-Host "==============================================================================" -ForegroundColor Yellow
    Write-Host " [!] Vortex Collection Tools is already running at http://${hostName}:$port" -ForegroundColor Yellow
    Write-Host ""
    if ($trayRunning) {
        Write-Host " The app is running in your system tray (near the clock, bottom-right" -ForegroundColor White
        Write-Host " of your screen -- click the ^ arrow if hidden icons are collapsed)." -ForegroundColor White
        Write-Host " Right-click the icon to open in your browser or shut it down." -ForegroundColor White
    } else {
        Write-Host " Another instance is already active. Check your taskbar for the orange" -ForegroundColor White
        Write-Host ' Vortex icon titled "Vortex Collection Tools" (right-click and choose "Quit"),' -ForegroundColor White
        Write-Host ' or run `stop.bat` to shut it down.' -ForegroundColor White
    }
    Write-Host ""
    Write-Host " Aborting startup to prevent duplicate instances." -ForegroundColor Red
    Write-Host "==============================================================================" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to close this window"
    exit 0
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Keep this window open while you use the app in your browser." -ForegroundColor Cyan
Write-Host " To stop the server when you're done, do ANY of these:" -ForegroundColor Cyan
Write-Host "   - Press Ctrl+C in this window" -ForegroundColor Cyan
Write-Host "   - Click the X to close this window" -ForegroundColor Cyan
Write-Host "   - Run stop.bat (from anywhere)" -ForegroundColor Cyan
Write-Host " All three shut it down the same safe way." -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Starting Vortex Collection Tools..."
& $nodeExe web/server.js
Write-Host ""
Read-Host "Server stopped. Press Enter to close this window"