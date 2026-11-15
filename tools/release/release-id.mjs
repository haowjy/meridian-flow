/**
 * The release id both Nitro builds stamp at build time: the app bundle and the API server must get
 * the same one, or every tab reads its own deploy as stale. `MERIDIAN_RELEASE` names it (the release
 * manifest's id once one exists) and wins in every mode, so a dev stack can stand in for a deploy.
 * Without it a production build takes the git SHA, or fails instead of inventing an id, since two
 * builds would invent two. Dev gets one fixed id, so it never differs between the two halves.
 */
import { execFileSync } from "node:child_process";

/** What a dev stack is stamped as; `observeServer` reads it as no information. */
export const DEV_RELEASE_ID = "dev";

/**
 * @param {{ dev: boolean }} where
 * @returns {string}
 */
export function resolveReleaseId({ dev }) {
  const named = process.env.MERIDIAN_RELEASE?.trim();
  if (named) return named;
  if (dev) return DEV_RELEASE_ID;
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "Set MERIDIAN_RELEASE: a production build needs a release id and there is no git checkout to take one from.",
    );
  }
}
