import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const shutdownChild = fileURLToPath(
  new URL("./__tests__/nitro-dev-shutdown-signal-child.ts", import.meta.url),
);
const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));

describe("Nitro dev supervisor shutdown", () => {
  it.each([
    "SIGTERM",
    "SIGINT",
  ] as const)("forwards %s to its worker and stays alive through the worker drain", async (signal) => {
    const tracePath = join(tmpdir(), `nitro-dev-shutdown-${crypto.randomUUID()}.log`);
    const child = spawn(process.execPath, ["--import", "tsx/esm", shutdownChild, tracePath], {
      cwd: serverDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await expect.poll(() => stdout, { timeout: 5_000 }).toContain("ready");
      child.kill(signal);
      await expect
        .poll(() => readFile(tracePath, "utf8").catch(() => ""), { timeout: 5_000 })
        .toContain("worker-signal");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(child.exitCode).toBeNull();
      child.kill(signal);
      const [exitCode, exitSignal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect({ exitCode, signal: exitSignal }).toEqual({ exitCode: 0, signal: null });
      if (stderr) throw new Error(stderr);
      expect((await readFile(tracePath, "utf8")).trim().split("\n")).toEqual([
        "supervisor-close",
        "worker-signal",
        "worker-drained",
        "worker-exit",
      ]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(tracePath, { force: true });
    }
  });
});
