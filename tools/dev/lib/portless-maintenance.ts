/** Best-effort shared route maintenance; never turn completed teardown into failure. */
import { spawnSync } from "node:child_process";

export function prunePortlessRoutes(cwd: string): void {
  const result = spawnSync("pnpm", ["exec", "portless", "prune"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status !== 0) {
    const reason =
      (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status ?? "unknown"}`;
    console.warn(`portless prune warning: ${reason}; retry with pnpm exec portless prune`);
  }
}
