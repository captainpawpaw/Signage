# Sets up this PC as a Signage screen:
#   1. installs the add-on in C:\ProgramData\Signage\addon
#   2. adds a task that keeps the add-on up to date (every 15 minutes; updates
#      are only installed if they carry a valid signature from your server)
#   3. starts Chrome (or Edge) fullscreen on the player whenever someone logs in
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dest = Join-Path $env:ProgramData 'Signage'
$addon = Join-Path $dest 'addon'
$server = Get-Content (Join-Path $here 'server.json') -Raw | ConvertFrom-Json

Write-Host "Setting up a screen for $($server.serverName)..."
New-Item -ItemType Directory -Force -Path $addon | Out-Null
Get-ChildItem $addon | Remove-Item -Recurse -Force
Copy-Item (Join-Path $here 'addon\*') $addon -Recurse -Force
Copy-Item (Join-Path $here 'update-addon.ps1'), (Join-Path $here 'server.json') $dest -Force

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$dest\update-addon.ps1"""
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Signage Add-on Updater' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null

$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'Signage Player.lnk'))
  $link.TargetPath = $browser
  $link.Arguments = "--kiosk ""chrome-extension://$($server.extensionId)/player.html"" --autoplay-policy=no-user-gesture-required --no-first-run --noerrdialogs --disable-session-crashed-bubble"
  $link.Save()
} else {
  Write-Host 'Chrome or Edge was not found - install one, then run this again.' -ForegroundColor Yellow
}

$name = if ($browser -like '*msedge*') { 'edge' } else { 'chrome' }
Write-Host ''
Write-Host 'Done. One step is left, because Chrome and Edge only allow it by hand:' -ForegroundColor Green
Write-Host "  1. Open $($name)://extensions"
Write-Host '  2. Turn on Developer mode'
Write-Host "  3. Click Load unpacked and choose $addon"
Write-Host ''
Write-Host 'The player opens fullscreen and shows a pairing code. In the Signage console'
Write-Host 'go to Screens > Pair a screen and enter it. From then on the screen starts'
Write-Host 'by itself when this PC logs in, and the add-on updates itself.'
