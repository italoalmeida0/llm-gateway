import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDist, DistError, EXPECTED_PLATFORMS } from "../scripts/verify-release-dist";

// V2-005 acceptance: the daemon-only manifest passes the SAME validator CI
// and the release workflow run, and every contract violation fails it.
function makeDist(version = "1.2.3") {
  const dir = mkdtempSync(join(tmpdir(), "llmgw-dist-"));
  const assets: Record<string, string> = {};
  const sums: Record<string, string> = {};
  const lines: string[] = [];
  for (const plat of EXPECTED_PLATFORMS) {
    const name = `indirect-code-${plat}${plat.startsWith("windows") ? ".exe" : ""}`;
    const buf = Buffer.from(`binary:${name}:version=${version}`);
    writeFileSync(join(dir, name), buf);
    const hash = createHash("sha256").update(buf).digest("hex");
    assets[plat] = name;
    sums[name] = hash;
    lines.push(`${hash}  ${name}`);
  }
  writeFileSync(join(dir, "SHA256SUMS.txt"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "versions.json"), JSON.stringify({ daemon: { version, assets, sums } }, null, 2));
  return dir;
}

function expectFail(dir: string, version: string | undefined, needle: string) {
  let failed = false;
  try {
    verifyDist(dir, version);
  } catch (e) {
    failed = true;
    expect(e).toBeInstanceOf(DistError);
    expect((e as Error).message).toContain(needle);
  }
  expect(failed).toBe(true);
}

describe("verify-release-dist (V2-005 shared release validator)", () => {
  test("valid single-artifact dist passes", () => {
    const dir = makeDist();
    try {
      const rep = verifyDist(dir, "1.2.3");
      expect(rep.checked).toBe(EXPECTED_PLATFORMS.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a launcher manifest section is a contract violation", () => {
    const dir = makeDist();
    try {
      const p = join(dir, "versions.json");
      const m = JSON.parse(readFileSync(p, "utf8"));
      m.launcher = { version: "1.2.3", assets: {}, sums: {} };
      writeFileSync(p, JSON.stringify(m));
      expectFail(dir, "1.2.3", 'exactly one "daemon" field');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing platform asset fails", () => {
    const dir = makeDist();
    try {
      unlinkSync(join(dir, "indirect-code-darwin-arm64"));
      expectFail(dir, "1.2.3", "asset file missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checksum mismatch fails", () => {
    const dir = makeDist();
    try {
      writeFileSync(join(dir, "indirect-code-linux-amd64"), "tampered");
      expectFail(dir, "1.2.3", "SHA256SUMS mismatch for indirect-code-linux-amd64");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wrong expected version fails", () => {
    const dir = makeDist();
    try {
      expectFail(dir, "9.9.9", "manifest version 1.2.3 != expected 9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("binary not stamped with the release version fails", () => {
    const dir = makeDist();
    try {
      // Bytes valid and checksums consistent, but the binary embeds no
      // version string (a stale build).
      const name = "indirect-code-linux-arm64";
      const buf = Buffer.from("binary-without-version-stamp");
      writeFileSync(join(dir, name), buf);
      const hash = createHash("sha256").update(buf).digest("hex");
      const sumsPath = join(dir, "SHA256SUMS.txt");
      writeFileSync(
        sumsPath,
        readFileSync(sumsPath, "utf8").replace(/^([0-9a-f]{64}) {2}indirect-code-linux-arm64$/m, `${hash}  ${name}`),
      );
      const p = join(dir, "versions.json");
      const m = JSON.parse(readFileSync(p, "utf8"));
      m.daemon.sums[name] = hash;
      writeFileSync(p, JSON.stringify(m));
      expectFail(dir, "1.2.3", "does not embed version 1.2.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extra unexpected platform fails", () => {
    const dir = makeDist();
    try {
      const p = join(dir, "versions.json");
      const m = JSON.parse(readFileSync(p, "utf8"));
      m.daemon.assets["plan9-mips"] = "indirect-code-plan9-mips";
      writeFileSync(p, JSON.stringify(m));
      expectFail(dir, "1.2.3", "unexpected platforms");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
