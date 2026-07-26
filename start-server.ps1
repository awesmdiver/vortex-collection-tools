# Same launcher as start-server.bat, for anyone who prefers "Run with PowerShell" or wants to
# customize the launch (edit the node invocation below to add e.g. -port/-host flags).
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
