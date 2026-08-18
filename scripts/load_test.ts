/**
 * Exact scenario runner and SQL before/after benchmark.
 *
 *   bun scripts/load_test.ts [directory] [days]
 *
 * The database is populated through the existing one-day transactional
 * backfill, then perf-tuning runs the same dashboard query set before and
 * after ANALYZE and covering-index candidates.
 */
import { existsSync, mkdirSync, rmSync } from "fs";
import path from "path";

const dir = path.resolve(process.argv[2] || "/tmp/gw-load-test-365");
const days = Number(process.argv[3] || 365);
if (!Number.isInteger(days) || days < 1) throw new Error("days must be a positive integer");
if (existsSync(path.join(dir, "gateway.db"))) {
  throw new Error(`refusing to overwrite existing database: ${dir}`);
}
mkdirSync(dir, { recursive: true });

const env = {
  ...process.env,
  PERF_NUM_USERS: "20",
  PERF_REQS_PER_USER_DAY: "500",
  PERF_AUDIT_PER_USER_DAY: "50",
  PERF_DAY_IN: "10000000",
  PERF_DAY_CACHE: "100000000",
  PERF_DAY_OUT: "500000",
};

const run = async (args: string[]) => {
  const proc = Bun.spawn({ cmd: ["bun", ...args], cwd: path.resolve(import.meta.dir, ".."), env, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} exited with ${code}`);
};

await run(["scripts/perf-tuning.ts", "build", dir, String(days)]);
await run(["scripts/perf-tuning.ts", "sql", dir]);
