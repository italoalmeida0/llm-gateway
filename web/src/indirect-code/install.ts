/** One-line install commands for the Indirect Code daemon.
 *
 * The gateway serves releases statically (/r/), so install
 * commands point at it (derived from the connectUrl's origin — same host
 * the daemon will pair with, no CDN cache in the path). GitHub raw stays
 * as documented fallback when the gateway isn't publicly reachable.
 * The script detects OS/arch at runtime, downloads the newest compatible
 * build into ~/.indirect-code/bin, pairs via the single-use connectUrl,
 * and detaches (nohup / Start-Process Hidden) so the terminal stays free.
 */

export const INDIRECT_REPO_RAW =
  "https://raw.githubusercontent.com/italoalmeida0/llm-gateway/main/indirect-code-daemon/dist";

/** Gateway origin derived from a connectUrl (fallback: GitHub raw). */
export function installBase(connectUrl: string): string {
  try {
    const u = new URL(connectUrl);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return `${u.origin}/r`;
    }
  } catch {}
  return INDIRECT_REPO_RAW;
}

export function indirectInstallCommands(connectUrl: string): {
  unix: string;
  windows: string;
} {
  const url = connectUrl || "<connectUrl>";
  const base = connectUrl ? installBase(connectUrl) : INDIRECT_REPO_RAW;
  return {
    unix: `curl -fsSL ${base}/indirect-install.sh | bash -s -- "${url}"`,
    windows: `powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm '${base}/indirect-install.ps1'))) -ConnectUrl '${url}'"`,
  };
}
