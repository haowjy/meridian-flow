import { execFileSync } from "node:child_process";
import path from "node:path";

/** Start the local postgres:16 container and wait until healthy. */
export function ensureDevInfraUp(repoRoot: string): void {
  const composeFile = path.join(repoRoot, "tools/dev/docker-compose.yml");
  execFileSync("docker", ["compose", "-f", composeFile, "up", "-d", "--wait"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
