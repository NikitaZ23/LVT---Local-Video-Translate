@echo off
setlocal

set "LVT_ROOT=%~dp0"
set "NODE_EXE=E:\NodeJs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"

powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$port = 5190; $root = [IO.Path]::GetFullPath($env:LVT_ROOT); $node = $env:NODE_EXE; $existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if (-not $existing) { Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden }; Start-Process ('http://localhost:' + $port + '/')"

