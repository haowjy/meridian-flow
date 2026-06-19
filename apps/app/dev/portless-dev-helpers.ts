/** Portless dev helpers — server origin resolution and CA-aware HTTPS agent. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

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

const PORTLESS_CA_PATH = path.join(os.homedir(), ".portless", "ca.pem");

export function createPortlessHttpsAgent(): https.Agent | undefined {
  if (!fs.existsSync(PORTLESS_CA_PATH)) {
    return undefined;
  }
  const ca = fs.readFileSync(PORTLESS_CA_PATH, "utf8");
  return new https.Agent({ ca: [...tls.rootCertificates, ca] });
}
