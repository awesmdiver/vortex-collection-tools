# Cleanly stops the server started by start-server.ps1/.bat, via the /api/shutdown route in
# web/server.js -- same graceful-close-with-grace-period the Settings page's "Restart Now" button
# uses. Ctrl+C and closing the start-server window work equally well; this is just a way to stop it
# from a different window/terminal.

Set-Location $PSScriptRoot

$port = 4321
$hostName = "127.0.0.1"
$configPath = Join-Path $PSScriptRoot "config.json"
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

try {
    Invoke-RestMethod -Uri "http://${hostName}:$port/api/shutdown" -Method Post -TimeoutSec 5 | Out-Null
    Write-Host "Server stopped." -ForegroundColor Green
}
catch {
    Write-Host "No server responding at http://${hostName}:${port} (already stopped?)." -ForegroundColor Yellow
}

Read-Host "Press Enter to close this window"
