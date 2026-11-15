/**
 * The release id both Nitro builds stamp at build time: the app bundle and the API server must get
 * the same one, or every tab reads its own deploy as stale. `MERIDIAN_RELEASE` names it (the release
 * manifest's id once one exists); otherwise the git SHA, which also keeps `pnpm dev` stable across restarts.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/** @returns {string} */
export function resolveReleaseId() {
  const named = process.env.MERIDIAN_RELEASE?.trim();
  if (named) return named;
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return `build-${randomUUID().slice(0, 8)}`;
  }
}
