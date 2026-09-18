# Indirect Code installer (Windows PowerShell).
# Usage: powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm '<gateway>/r/indirect-install.ps1'))) <gateway-url> <token>"
#
# The script does the MINIMUM to boot the launcher; the launcher owns the
# house (repairs broken installs, adopts stray state, picks the active
# slot). Worst case — even a broken update — a manual reinstall recovers
# to bootable.
#
# Layout (canonical):
#   ~/.indirect-code/
#     brain/  slots/{active,slot-a,slot-b}/  logs/  external/
#
# Output contract: quiet on success (one line per step, "done" at the end).
# Full detail always lands in logs/install.log; errors print what failed
# and where the log is.
param(
  [Parameter(Mandatory = $true)][string]$GatewayUrl,
  [Parameter(Mandatory = $true)][string]$Token
)
$ErrorActionPreference = "Stop"
$GW = $GatewayUrl.TrimEnd("/")

$ROOT = Join-Path $HOME ".indirect-code"
$LOGS = Join-Path $ROOT "logs"
New-Item -ItemType Directory -Force -Path $LOGS | Out-Null
$ILOG = Join-Path $LOGS "install.log"
Start-Transcript -Path $ILOG -Append | Out-Null
function Step($msg) { Write-Host "$msg ... " -NoNewline }
function Ok { Write-Host "done" }
function Fail($msg) {
  Write-Host "FAILED"
  Write-Host "Error: $msg"
  Write-Host "See $ILOG for details."
  exit 1
}
try {
  Step "Preparing"
  $ARCH = (Get-CimInstance Win32_Processor).AddressWidth
  if ($ARCH -eq 64) {
    $archName = if ($env:PROCESSOR_ARCHITECTURE -match "ARM64") { "arm64" } else { "amd64" }
  } else { Fail "unsupported arch: $env:PROCESSOR_ARCHITECTURE" }
  $ASSET = "indirect-launcher-windows-$archName.exe"
  Ok

  # 1. Discover the active slot: slots/active wins; else live daemon.pid;
  #    else freshest slot; else slot-a (fresh install).
  $ACTIVE = ""
  $activeFile = Join-Path $ROOT "slots/active"
  if (Test-Path $activeFile) {
    $raw = (Get-Content $activeFile -Raw) -replace "[^ab]", ""
    if ($raw.Length -ge 1) { $ACTIVE = $raw[0] }
  }
  if (-not $ACTIVE) {
    foreach ($s in @("a", "b")) {
      $pidFile = Join-Path $ROOT "slots/slot-${s}/daemon.pid"
      if (Test-Path $pidFile) {
        $pid = (Get-Content $pidFile -Raw).Trim()
        if ($pid -match "^\d+$" -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { $ACTIVE = $s; break }
      }
    }
  }
  if (-not $ACTIVE) {
    $best = ""; $bestTime = [datetime]::MinValue
    foreach ($s in @("a", "b")) {
      $d = Join-Path $ROOT "slots/slot-${s}"
      if (Test-Path $d) {
        $t = (Get-Item $d).LastWriteTime
        $sd = Join-Path $d "sessions"
        if (Test-Path $sd) { $t = (Get-Item $sd).LastWriteTime }
        if ($t -gt $bestTime) { $bestTime = $t; $best = $s }
      }
    }
    $ACTIVE = if ($best) { $best } else { "a" }
  }

  # 2. Stop the running daemon (if any) so binaries can be replaced.
  foreach ($s in @($ACTIVE, "a", "b")) {
    $pidFile = Join-Path $ROOT "slots/slot-${s}/daemon.pid"
    if (Test-Path $pidFile) {
      $pid = (Get-Content $pidFile -Raw).Trim()
      $proc = $null
      if ($pid -match "^\d+$") { $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue }
      if ($proc) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        $proc.WaitForExit(5000)
      }
    }
  }

  # 3. Download the launcher into the ACTIVE slot (fixed name, no -v copies).
  Step "Downloading launcher"
  $SLOTDIR = Join-Path $ROOT "slots/slot-${ACTIVE}"
  New-Item -ItemType Directory -Force -Path (Join-Path $SLOTDIR "bin") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "brain") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "external") | Out-Null
  $dest = Join-Path $SLOTDIR "bin/${ASSET}"
  $tmp = "${dest}.download"
  try {
    Invoke-WebRequest -Uri "${GW}/r/${ASSET}?u=install-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -OutFile $tmp -UseBasicParsing
  } catch { Fail "could not download ${ASSET} from ${GW} ($($_.Exception.Message))" }
  $ver = & $tmp --version 2>&1
  if ($ver -notmatch "launcher") { Fail "downloaded file is not a launcher (bad gateway response?)" }
  Move-Item -Force $tmp $dest
  Ok

  # 4. Hand over: the launcher repairs the rest, fetches the daemon,
  #    migrates storage, verifies, and boots.
  Write-Host "Starting ..."
  $CONNECT_URL = "${GW}/api/indirect-code/connect/${Token}"
  & $dest -connect $CONNECT_URL
} finally {
  Stop-Transcript | Out-Null
}
