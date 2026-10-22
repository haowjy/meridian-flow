/** Process working-directory evidence for checkout-owned Portless routes. */
import { execFileSync } from "node:child_process";
import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

export function processWorkingDirectory(pid: number): string | undefined {
  if (pid <= 0) return undefined;
  try {
    if (process.platform === "linux") return realpathSync(readlinkSync(`/proc/${pid}/cwd`));
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const cwd = output
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    return cwd ? realpathSync(cwd) : undefined;
  } catch {
    return undefined;
  }
}

export function pidBelongsToCheckout(pid: number, repoRoot: string): boolean {
  const cwd = processWorkingDirectory(pid);
  if (!cwd) return false;
  const relative = path.relative(realpathSync(repoRoot), cwd);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
