/** One-line install commands for the Indirect Code daemon.
 *
 * The binaries are committed to the repo (indirect-code-daemon/dist/) and
 * fetched from raw.githubusercontent.com so the command works even when the
 * gateway's PUBLIC_URL is misconfigured. The script detects OS/arch at
 * runtime, downloads the newest compatible build into ~/.indirect-code/bin,
 * pairs via the single-use connectUrl, and detaches (nohup / Start-Process
 * Hidden) so the terminal stays free.
 */

export const INDIRECT_REPO_RAW =
  "https://raw.githubusercontent.com/italoalmeida0/llm-gateway/main/indirect-code-daemon/dist";

export function indirectInstallCommands(connectUrl: string): {
  unix: string;
  windows: string;
} {
  const url = connectUrl || "<connectUrl>";
  return {
    unix: `curl -fsSL ${INDIRECT_REPO_RAW}/indirect-install.sh | bash -s -- "${url}"`,
    windows: `powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm '${INDIRECT_REPO_RAW}/indirect-install.ps1'))) -ConnectUrl '${url}'"`,
  };
}
