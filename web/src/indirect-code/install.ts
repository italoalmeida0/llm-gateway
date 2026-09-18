/** One-line install commands for the Indirect Code daemon. */

export function parseConnectParams(connectUrl: string): { gateway: string; token: string } {
  try {
    const u = new URL(connectUrl);
    const m = u.pathname.match(/\/connect\/([a-zA-Z0-9_-]+)/);
    if (m) {
      return { gateway: u.origin, token: m[1] };
    }
    return { gateway: u.origin, token: "" };
  } catch {
    return { gateway: "", token: "" };
  }
}

export function indirectInstallCommands(connectUrl: string): {
  unix: string;
  windows: string;
} {
  const { gateway, token } = parseConnectParams(connectUrl);
  const gw = gateway || "<gateway>";
  const tok = token || "<token>";
  // Third arg is optional: the host display name. Empty = the daemon
  // falls back to os.Hostname() (e.g. DESKTOP-ABC123, never host_...).
  return {
    unix: `curl -fsSL ${gw}/r/indirect-install.sh | bash -s -- ${gw} ${tok} "$(hostname)"`,
    windows: `powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm '${gw}/r/indirect-install.ps1'))) ${gw} ${tok} $env:COMPUTERNAME"`,
  };
}
