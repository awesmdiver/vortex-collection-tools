@echo off
rem Double-click launcher: runs start-server.ps1, which does the real work (bundled-vs-PATH node
rem resolution, checking whether a server is already running before starting a second one, and
rem starting the server itself). Same relationship stop.bat already has to stop.ps1 -- one real
rem implementation, not two hand-duplicated copies that can quietly drift apart from each other
rem (GitHub issue #4: that drift is exactly how a wrong config.json path went unnoticed before).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
