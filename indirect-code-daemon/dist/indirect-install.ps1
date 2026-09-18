# Indirect Code one-line installer (Windows PowerShell).
#
# Copiado do dashboard como:
#   powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm '<seu-gateway>/r/indirect-install.ps1'))) -ConnectUrl '<connectUrl>'"
#
# Faz: detecta arch -> para daemon anterior -> baixa o .exe compatível mais recente ->
# instala em ~/.indirect-code/bin -> unblock-file -> pareia (-connect) -> deixa rodando
# em segundo plano (Start-Process Hidden, sem prender o terminal).
param(
  [Parameter(Position = 0)][string]$ConnectUrl = $env:INDIRECT_CONNECT_URL,
  [string]$Name = "",
  [string]$RepoRaw = $env:INDIRECT_REPO_RAW
)

if ([string]::IsNullOrWhiteSpace($ConnectUrl)) {
  if (-not [string]::IsNullOrWhiteSpace($env:CONNECT_URL)) {
    $ConnectUrl = $env:CONNECT_URL
  }
}

if ([string]::IsNullOrWhiteSpace($ConnectUrl)) {
  Write-Error "[indirect] ConnectUrl is required. Usage: indirect-install.ps1 -ConnectUrl '<url>'"
  exit 1
}

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRaw)) {
  # Derive from ConnectUrl (gateway serves everything via /r/).
  # No GitHub fallback by design: without a gateway URL there is nothing
  # to pair with (ConnectUrl is mandatory above).
  if ($ConnectUrl -match '^(https?://[^/]+)') { $RepoRaw = $Matches[1] + "/r" }
  else { Write-Error "[indirect] cannot derive download URL"; exit 1 }
}

$DataDir = Join-Path $HOME ".indirect-code"
$BinDir = Join-Path $DataDir "bin"
$LogFile = Join-Path $DataDir "daemon.log"
$ErrFile = Join-Path $DataDir "daemon.err.log"
$PidFile = Join-Path $DataDir "daemon.pid"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# --- Stop previous daemon / launcher (if any) before replacing binary ---
# On Windows, running .exe files are locked against deletion and replacement.
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

# Clean up stray AppData directory if it was created by an older launcher version
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
# TLS 1.2 for Windows PowerShell 5.1
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
Invoke-WebRequest -Uri $Url -OutFile "$Bin.tmp" -UseBasicParsing
if (Test-Path $Bin) {
  Remove-Item -Force $Bin -ErrorAction SilentlyContinue
  if (Test-Path $Bin) {
    # If the file is still locked or cannot be deleted directly, NTFS allows renaming it
    $oldBin = "$Bin.old." + [System.Guid]::NewGuid().ToString("N")
    Rename-Item -Path $Bin -NewName (Split-Path $oldBin -Leaf) -Force -ErrorAction SilentlyContinue
    Remove-Item -Force $oldBin -ErrorAction SilentlyContinue
  }
}
# Copy-Item then Remove-Item avoids the PowerShell 5.1 bug where Move-Item -Force
# throws 'Cannot create a file when that file already exists'
Copy-Item -Path "$Bin.tmp" -Destination $Bin -Force
Remove-Item -Force "$Bin.tmp" -ErrorAction SilentlyContinue
# Strip Mark-of-the-Web (Zone.Identifier) so Windows Defender / SmartScreen doesn't block unsigned execution
Unblock-File -Path $Bin -ErrorAction SilentlyContinue

# --- Pair + detach (Hidden window: prompt stays free) ---
# NOTE: $args is a PowerShell automatic variable, so the daemon argv lives
# in $daemonArgs instead. Start-Process requires distinct stdout/stderr
# files, so stderr goes to daemon.err.log (kept tiny/empty in practice).
if ($ConnectUrl -match '^(https?://[^/]+)') {
  $env:INDIRECT_GATEWAY = $Matches[1]
}
$env:INDIRECT_REPO_RAW = $RepoRaw
Remove-Item -Force $PidFile -ErrorAction SilentlyContinue

$daemonArgs = @('-connect', $ConnectUrl)
if (-not [string]::IsNullOrWhiteSpace($Name)) { $daemonArgs += @('--name', $Name) }
Write-Host "[indirect] pairing and starting in background (log: $LogFile) ..."
Start-Process -FilePath $Bin -ArgumentList $daemonArgs -WindowStyle Hidden `
  -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

# First start downloads unish/python runtimes (~30s+), so poll for the pid.
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
