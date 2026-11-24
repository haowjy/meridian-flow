import { execFileSync } from "node:child_process";

export const DEV_RELEASE_ID = "dev";

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
