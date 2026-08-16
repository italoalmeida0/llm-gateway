/**
 * scripts/perf-router-bench.ts — hot-path A/B for the failover architecture.
 *
 * Same stack, same dataset, two routing regimes + failover regimes:
 *
 *   passthrough   legacy behavior (providers walked in priority order)
 *   router        model registry resolution + per-model target chains
 *   router+skip   primary upstream key billing-exhausted (chain skips it)
 *
 * Each arm hammers non-stream chat completions (default 2000 req @ 50 conc)
 * and reports rps + p50/p95 + gateway overhead vs a direct-to-upstream arm.
 * The router arm runs FIRST on a warm fresh stack; passthrough second, so a
 * cold-start bias would only HELP the second arm.
 *
 * Run: bun run perf:router-bench
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  GW, UP, UPSTREAM_KEY, NUM_USERS,
  startStack, stopStack, provisionRouter, setUpstreamFail,
  measureDirect,
  type Stack, type ProxyStats, type RouterTopology,
} from "./perf-common";

const REQUESTS = Number(process.env.BENCH_REQUESTS || 2000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY || 50);

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Parallel non-stream POSTs rotating across the user keys. */
async function hammer(users: { gwKey: string }[], count: number, concurrency: number): Promise<ProxyStats> {
  const lat: number[] = [];
  let errors = 0;
  let idx = 0;
  const started = performance.now();
  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= count) return;
      const user = users[my % users.length]!;
      const t0 = performance.now();
      try {
        const res = await fetch(`${GW}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.gwKey}` },
          body: JSON.stringify({
            model: "gpt-5-mini",
            stream: false,
            messages: [{ role: "user", content: "bench probe" }],
          }),
        });
        await res.arrayBuffer();
        if (res.status >= 400) errors++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - started;
  lat.sort((a, b) => a - b);
  return {
    n: lat.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    min: lat[0]!,
    max: lat[lat.length - 1]!,
    mean: lat.reduce((a, b) => a + b, 0) / lat.length,
    errors,
    rps: (lat.length / wallMs) * 1000,
  };
}

function printArm(name: string, s: ProxyStats, direct: ProxyStats) {
  console.log(
    `${name.padEnd(26)} ${Math.round(s.rps).toLocaleString("en-US").padStart(8)} rps | ` +
      `p50 ${s.p50.toFixed(2).padStart(7)}ms | p95 ${s.p95.toFixed(2).padStart(7)}ms | ` +
      `overhead p50 ${(s.p50 - direct.p50).toFixed(2).padStart(6)}ms p95 ${(s.p95 - direct.p95).toFixed(2).padStart(6)}ms | ` +
      `err ${s.errors}`,
  );
}

const dataDir = mkdtempSync(path.join(tmpdir(), "gw-perf-rbench-"));
const stack: Stack = await startStack(dataDir, { fallbackUpstream: true });

try {
  const { adminToken, users, topo } = await provisionRouter(NUM_USERS);

  const setMode = async (mode: "passthrough" | "router") => {
    const res = await fetch(`${GW}/api/admin/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ routingMode: mode }),
    });
    if (!res.ok) throw new Error(`failed to set routing mode: ${res.status}`);
  };
  const resetKey = async (providerId: string, keyId: string) => {
    await fetch(`${GW}/api/admin/providers/${providerId}/keys/${keyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "active" }),
    });
  };

  console.log(`[router-bench] ${REQUESTS} req/arm @ concurrency ${CONCURRENCY} (fake upstream latency 5ms)`);

  const direct = await measureDirect(200, CONCURRENCY);

  // warm-ups per arm keep JIT/connection pools out of the numbers
  await setMode("router");
  await hammer(users, 200, CONCURRENCY);
  const router = await hammer(users, REQUESTS, CONCURRENCY);

  await setMode("passthrough");
  await hammer(users, 200, CONCURRENCY);
  const passthrough = await hammer(users, REQUESTS, CONCURRENCY);

  // router mode again with the primary key billing-exhausted (steady skip)
  await setMode("router");
  await setUpstreamFail(UP, UPSTREAM_KEY, { status: 402, message: "insufficient_quota" });
  await hammer(users, 10, 1); // first requests exhaust the key + fail over
  await hammer(users, 200, CONCURRENCY);
  const skip = await hammer(users, REQUESTS, CONCURRENCY);

  console.log(`\n===== HOT PATH A/B =====`);
  printArm("direct upstream", direct, direct);
  printArm("router", router, direct);
  printArm("passthrough", passthrough, direct);
  printArm("router + dead primary key", skip, direct);

  await setUpstreamFail(UP, UPSTREAM_KEY, null);
  await resetKey(topo.providerA, topo.keyA1);
} finally {
  await stopStack(stack);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
