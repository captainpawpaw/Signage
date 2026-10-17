# Removes the Signage server scheduled task and firewall rules, and stops the
# server. Your media, playlists and settings in the data folder are kept.
$ErrorActionPreference = 'Continue'
$taskName = 'Signage Server'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'server[\\/]index\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-NetFirewallRule -DisplayName 'Signage Server*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Remove-Item (Join-Path $PSScriptRoot 'run-server.cmd') -ErrorAction SilentlyContinue
Write-Host 'The Signage server no longer starts automatically. Use start-signage.bat to run it by hand.' -ForegroundColor Green
