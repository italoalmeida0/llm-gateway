# Indirect Code one-line installer (Windows PowerShell).
#
# Copiado do dashboard como:
#   powershell -c "irm https://raw.githubusercontent.com/italoalmeida0/llm-gateway/main/indirect-code-daemon/dist/indirect-install.ps1 -OutFile $env:TEMP\indirect-install.ps1; & $env:TEMP\indirect-install.ps1 -ConnectUrl '<connectUrl>'"
#
# Faz: detecta arch -> baixa o .exe compatível mais recente ->
# instala em ~/.indirect-code/bin -> pareia (-connect) -> deixa rodando
# em segundo plano (Start-Process Hidden, sem prender o terminal).
param(
  [Parameter(Mandatory = $true)][string]$ConnectUrl,
  [string]$Name = "",
  [string]$RepoRaw = $env:INDIRECT_REPO_RAW
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRaw)) {
  $RepoRaw = "https://raw.githubusercontent.com/italoalmeida0/llm-gateway/main/indirect-code-daemon/dist"
}

$DataDir = Join-Path $HOME ".indirect-code"
$BinDir = Join-Path $DataDir "bin"
$LogFile = Join-Path $DataDir "daemon.log"
$ErrFile = Join-Path $DataDir "daemon.err.log"
$PidFile = Join-Path $DataDir "daemon.pid"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# --- Detect arch ---
$rawArch = $env:PROCESSOR_ARCHITECTURE
if ([string]::IsNullOrWhiteSpace($rawArch)) { $rawArch = "AMD64" }
switch ($rawArch.ToUpperInvariant()) {
  "AMD64" { $arch = "amd64" }
  "ARM64" { $arch = "arm64" }
  default { Write-Error "unsupported arch: $rawArch (supported: AMD64, ARM64)"; exit 1 }
}

$Asset = "indirect-code-windows-$arch.exe"
$Url = "$RepoRaw/$Asset"
$Bin = Join-Path $BinDir "indirect-code.exe"

Write-Host "[indirect] downloading $Asset ..."
# TLS 1.2 for Windows PowerShell 5.1
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
Invoke-WebRequest -Uri $Url -OutFile "$Bin.tmp" -UseBasicParsing
Move-Item -Force "$Bin.tmp" $Bin

# --- Stop previous daemon (if any) ---
if (Test-Path $PidFile) {
  $oldPidRaw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $oldPid = ""
  if ($null -ne $oldPidRaw) { $oldPid = "$oldPidRaw".Trim() }
  if ($oldPid -match '^\d+$') {
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "[indirect] stopping previous daemon (pid $oldPid) ..."
      try { & $Bin --stop } catch { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 1
    }
  }
}

# --- Pair + detach (Hidden window: prompt stays free) ---
# NOTE: $args is a PowerShell automatic variable, so the daemon argv lives
# in $daemonArgs instead. Start-Process requires distinct stdout/stderr
# files, so stderr goes to daemon.err.log (kept tiny/empty in practice).
$daemonArgs = @('-connect', $ConnectUrl)
if (-not [string]::IsNullOrWhiteSpace($Name)) { $daemonArgs += @('--name', $Name) }
Write-Host "[indirect] pairing and starting in background (log: $LogFile) ..."
Start-Process -FilePath $Bin -ArgumentList $daemonArgs -WindowStyle Hidden `
  -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

Start-Sleep -Seconds 2
if (Test-Path $PidFile) {
  $pidRaw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $pid2 = ""
  if ($null -ne $pidRaw) { $pid2 = "$pidRaw".Trim() }
  $proc2 = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  if ($proc2) {
    Write-Host "[indirect] daemon running in background (pid $pid2)."
    Write-Host "[indirect] Dashboard should show the host online in a few seconds."
    Write-Host "[indirect] Stop locally anytime: ~\.indirect-code\bin\indirect-code.exe --stop"
    exit 0
  }
}
Write-Error "[indirect] started, but pid check failed - see $LogFile"
Get-Content $LogFile -Tail 20 -ErrorAction SilentlyContinue
Get-Content $ErrFile -Tail 20 -ErrorAction SilentlyContinue
exit 1
