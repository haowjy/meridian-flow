import { execSync } from "node:child_process";

/**
 * Resolve the paired server origin via `portless get`. Portless is the
 * source of truth for worktree-prefixed hostnames — calling it directly
 * avoids reimplementing its branch → hostname logic.
 */
export function resolvePortlessServerOrigin(repoRoot: string): string | undefined {
  try {
    return (
      execSync("pnpm exec portless get server.meridian", {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
