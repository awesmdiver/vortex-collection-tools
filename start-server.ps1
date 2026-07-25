# Same launcher as start-server.bat, for anyone who prefers "Run with PowerShell" or wants to
# customize the launch (edit the node invocation below to add e.g. -port/-host flags).
#
# Works two ways:
#   - Self-contained release zip: uses the bundled node\node.exe and pre-installed node_modules --
#     nothing to install, just run this.
#   - Plain git clone: falls back to whatever "node" is on PATH, and runs npm install once if
#     node_modules is missing.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$bundledNode = Join-Path $PSScriptRoot "node\node.exe"
if (Test-Path $bundledNode) {
    $nodeExe = $bundledNode
    $npmCmd = Join-Path $PSScriptRoot "node\npm.cmd"
} else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js was not found on PATH."
        Write-Host "Install it from https://nodejs.org/ (the LTS version) and run this again."
        Read-Host "Press Enter to exit"
        exit 1
    }
    $nodeExe = "node"
    $npmCmd = "npm"
}

if (-not (Test-Path "node_modules")) {
    Write-Host "First run: installing dependencies..."
    & $npmCmd install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed -- see the errors above."
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Write-Host "Starting Vortex Collection Tools..."
& $nodeExe web/server.js
Write-Host ""
Write-Host "Server stopped."
Read-Host "Press Enter to exit"
