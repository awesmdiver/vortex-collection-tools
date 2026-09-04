# Cleanly stops the server, via the /api/shutdown route in web/server.js -- same graceful-close-
# with-grace-period the Settings page's "Restart Now" button uses. Works no matter how the server
# was started: a plain start-server.ps1/.bat window (Ctrl+C or closing that window also works
# equally well there), or the system tray launcher (which, as of GitHub issue #4's fix, correctly
# recognizes this as a deliberate stop and leaves the server stopped rather than restarting it).

Set-Location $PSScriptRoot

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

# The tray launcher (VortexCollectionTools.exe), if running, will notice the clean shutdown below
# and correctly leave the server stopped -- mentioned so this doesn't read as "stopped, but who
# knows what happens next" when the tray is the thing actually supervising it.
$trayRunning = $null -ne (Get-Process -Name "VortexCollectionTools" -ErrorAction SilentlyContinue)

try {
    Invoke-RestMethod -Uri "http://${hostName}:$port/api/shutdown" -Method Post -TimeoutSec 5 | Out-Null
    Write-Host "Server stopped." -ForegroundColor Green
    if ($trayRunning) {
        Write-Host "The system tray icon will update to show it as stopped -- right-click it any time to start it again." -ForegroundColor Green
    }
}
catch {
    Write-Host "No server responding at http://${hostName}:${port} -- it's already stopped." -ForegroundColor Yellow
}

Read-Host "Press Enter to close this window"
