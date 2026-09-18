# Indirect Code installer (Windows PowerShell).
# Usage:
#   powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm '<gatewayUrl>/r/indirect-install.ps1'))) <gatewayUrl> <token>"
param(
  [Parameter(Position = 0, Mandatory = $true)][string]$Gateway,
  [Parameter(Position = 1, Mandatory = $true)][string]$Token
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Gateway) -or [string]::IsNullOrWhiteSpace($Token)) {
  Write-Error "[indirect] usage: indirect-install.ps1 <gatewayUrl> <token>"
  exit 1
}

$Gateway = $Gateway.TrimEnd('/')
$ConnectUrl = "$Gateway/api/indirect-code/connect/$Token"
$RepoRaw = "$Gateway/r"

$DataDir = Join-Path $HOME ".indirect-code"
$BinDir = Join-Path $DataDir "bin"
$LogFile = Join-Path $DataDir "daemon.log"
$ErrFile = Join-Path $DataDir "daemon.err.log"
$PidFile = Join-Path $DataDir "daemon.pid"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# --- Stop previous daemon / launcher (if any) before replacing binary ---
$possiblePidFiles = @(
  $PidFile,
  (Join-Path (Join-Path $env:APPDATA "indirect-code") "daemon.pid")
)
foreach ($pf in $possiblePidFiles) {
  if (Test-Path $pf) {
    $oldPidRaw = (Get-Content $pf -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($null -ne $oldPidRaw -and "$oldPidRaw".Trim() -match '^\d+$') {
      Stop-Process -Id ([int]"$oldPidRaw".Trim()) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Force $pf -ErrorAction SilentlyContinue
  }
}

Get-Process -Name "indirect-code*", "indirect-launcher*" -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "[indirect] stopping running process $($_.ProcessName) (pid $($_.Id)) ..."
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 600

$strayAppData = Join-Path $env:APPDATA "indirect-code"
if (Test-Path $strayAppData) {
  Remove-Item -Recurse -Force $strayAppData -ErrorAction SilentlyContinue
}

# --- Detect arch ---
$rawArch = $env:PROCESSOR_ARCHITECTURE
if ([string]::IsNullOrWhiteSpace($rawArch)) { $rawArch = "AMD64" }
switch ($rawArch.ToUpperInvariant()) {
  "AMD64" { $arch = "amd64" }
  "ARM64" { $arch = "arm64" }
  default { Write-Error "unsupported arch: $rawArch (supported: AMD64, ARM64)"; exit 1 }
}

$Asset = "indirect-launcher-windows-$arch.exe"
$Url = "$RepoRaw/$Asset"
$Bin = Join-Path $BinDir "indirect-code.exe"

Write-Host "[indirect] downloading $Asset ..."
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
Invoke-WebRequest -Uri $Url -OutFile "$Bin.tmp" -UseBasicParsing
if (Test-Path $Bin) {
  Remove-Item -Force $Bin -ErrorAction SilentlyContinue
  if (Test-Path $Bin) {
    $oldBin = "$Bin.old." + [System.Guid]::NewGuid().ToString("N")
    Rename-Item -Path $Bin -NewName (Split-Path $oldBin -Leaf) -Force -ErrorAction SilentlyContinue
    Remove-Item -Force $oldBin -ErrorAction SilentlyContinue
  }
}
Copy-Item -Path "$Bin.tmp" -Destination $Bin -Force
Remove-Item -Force "$Bin.tmp" -ErrorAction SilentlyContinue
Unblock-File -Path $Bin -ErrorAction SilentlyContinue

$env:INDIRECT_GATEWAY = $Gateway
$env:INDIRECT_REPO_RAW = $RepoRaw
Remove-Item -Force $PidFile -ErrorAction SilentlyContinue

Write-Host "[indirect] pairing and starting in background (log: $LogFile) ..."
Start-Process -FilePath $Bin -ArgumentList @('-connect', $ConnectUrl) -WindowStyle Hidden `
  -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

# Poll for daemon pid (first start downloads daemon binary + runtimes)
$pid2 = ""
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $PidFile) {
    $pidRaw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($null -ne $pidRaw -and "$pidRaw".Trim() -match '^\d+$') {
      $testPid = [int]"$pidRaw".Trim()
      $proc2 = Get-Process -Id $testPid -ErrorAction SilentlyContinue
      if ($proc2) {
        $pid2 = "$testPid"
        break
      }
    }
  }
}
if ($pid2) {
  Write-Host "[indirect] daemon running in background (pid $pid2)."
  Write-Host "[indirect] Dashboard should show the host online in a few seconds."
  Write-Host "[indirect] Stop locally anytime: ~\.indirect-code\bin\indirect-code.exe --stop"
  exit 0
}
Write-Error "[indirect] started, but pid check failed - see $LogFile"
Get-Content $LogFile -Tail 20 -ErrorAction SilentlyContinue
Get-Content $ErrFile -Tail 20 -ErrorAction SilentlyContinue
exit 1
