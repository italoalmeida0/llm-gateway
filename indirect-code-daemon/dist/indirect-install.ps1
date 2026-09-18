# Indirect Code installer (Windows PowerShell).
# Usage: powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm '<gateway>/r/indirect-install.ps1'))) <gateway-url> <token>"
param(
  [Parameter(Mandatory = $true)][string]$GatewayUrl,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$HostName = ""
)


if ([string]::IsNullOrWhiteSpace($HostName)) {
  try {
    $HostName = [System.Net.Dns]::GetHostName()
  } catch {}
  if ([string]::IsNullOrWhiteSpace($HostName)) {
    try {
      $tcpip = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" -ErrorAction Stop
      if (-not [string]::IsNullOrWhiteSpace($tcpip.Hostname)) {
        $HostName = $tcpip.Hostname
      } elseif (-not [string]::IsNullOrWhiteSpace($tcpip.'NV Hostname')) {
        $HostName = $tcpip.'NV Hostname'
      }
    } catch {}
  }
  if ([string]::IsNullOrWhiteSpace($HostName)) {
    try { $HostName = $env:COMPUTERNAME } catch {}
  }
}

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


  Step "Downloading launcher"
  $SLOTDIR = Join-Path $ROOT "slots/slot-${ACTIVE}"
  New-Item -ItemType Directory -Force -Path (Join-Path $SLOTDIR "bin") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "brain") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "external") | Out-Null
  $dest = Join-Path $SLOTDIR "bin/${ASSET}"
  
  $tmp = "${dest}.tmp.exe"
  try {
    Invoke-WebRequest -Uri "${GW}/r/${ASSET}?u=install-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -OutFile $tmp -UseBasicParsing
  } catch { Fail "could not download ${ASSET} from ${GW} ($($_.Exception.Message))" }

  $ver = & $tmp --version 2>&1
  if ($ver -notmatch "launcher") {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    Fail "downloaded file is not a launcher (bad gateway response?)"
  }
  Move-Item -Force $tmp $dest
  Ok

  Write-Host "Starting ..."
  $CONNECT_URL = "${GW}/api/indirect-code/connect/${Token}"
  $daemonArgs = @("-connect", $CONNECT_URL)
  if (-not [string]::IsNullOrWhiteSpace($HostName)) { $daemonArgs += @("--name", $HostName) }
  $DLOG = Join-Path $LOGS "daemon.log"
  Start-Process -FilePath $dest -ArgumentList $daemonArgs -WindowStyle Hidden `
    -RedirectStandardOutput $DLOG -RedirectStandardError "$DLOG.err" | Out-Null
  Write-Host "done"
  Write-Host "Running in the background - the dashboard shows this host online in a few seconds."
} finally {
  Stop-Transcript | Out-Null
}