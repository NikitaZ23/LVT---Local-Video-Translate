@echo off
setlocal

set "PORT=5190"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Method POST http://localhost:%PORT%/api/shutdown | Out-Null; Write-Host 'LVT shutdown command sent.' } catch { Write-Host $_.Exception.Message }"
pause

