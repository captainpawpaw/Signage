# Keeps the Signage add-on up to date (runs every 15 minutes as a scheduled task).
# A new version is installed only if its signature matches the server key that
# was saved when this screen was set up, so nobody on the network can push code.
$ErrorActionPreference = 'Stop'
$dest = $PSScriptRoot
$addon = Join-Path $dest 'addon'
$log = Join-Path $dest 'update.log'
function Write-Log($message) { Add-Content -Path $log -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message) }

try {
  $cfg = Get-Content (Join-Path $dest 'server.json') -Raw | ConvertFrom-Json
  $current = (Get-Content (Join-Path $addon 'manifest.json') -Raw | ConvertFrom-Json).version
  $base = $null
  $latest = $null
  foreach ($url in $cfg.candidates) {
    try {
      $v = Invoke-RestMethod -Uri "$url/addon/version.json" -TimeoutSec 5 -UseBasicParsing
      if ($v.serverId -eq $cfg.serverId) { $base = $url; $latest = $v.version; break }
    } catch {}
  }
  if (-not $base -or $latest -eq $current) { exit 0 }

  $tmp = Join-Path $env:TEMP ('signage-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'addon.zip'
    $res = Invoke-WebRequest -Uri "$base/addon/signage-chrome.zip" -OutFile $zip -PassThru -UseBasicParsing -TimeoutSec 300
    $sig = [Convert]::FromBase64String(($res.Headers['X-Signage-Signature'] | Select-Object -First 1))

    # ECDSA P-256 public key blob for CNG: "ECS1", key length 32, then X and Y.
    [byte[]]$blob = @(0x45, 0x43, 0x53, 0x31, 0x20, 0, 0, 0) + [Convert]::FromBase64String($cfg.signKeyXY)
    $key = [System.Security.Cryptography.CngKey]::Import($blob, [System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    $ecdsa = New-Object System.Security.Cryptography.ECDsaCng($key)
    if (-not $ecdsa.VerifyData([IO.File]::ReadAllBytes($zip), $sig, [System.Security.Cryptography.HashAlgorithmName]::SHA256)) {
      Write-Log "Rejected an update from ${base}: the signature does not match this server's key."
      exit 1
    }

    $unpacked = Join-Path $tmp 'addon'
    Expand-Archive -Path $zip -DestinationPath $unpacked -Force
    if (-not (Test-Path (Join-Path $unpacked 'manifest.json'))) { throw 'download has no manifest.json' }
    Get-ChildItem $addon | Remove-Item -Recurse -Force
    Copy-Item (Join-Path $unpacked '*') $addon -Recurse -Force
    Write-Log "Updated the add-on from $current to $latest ($base). It reloads itself within a minute."
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Log "Update check failed: $_"
}
