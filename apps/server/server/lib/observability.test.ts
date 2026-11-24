/** Real process signals must settle paid runtime work before flushing and exiting.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Parallel process drains, deadlines, and second-signal exit
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
const loader = import.meta.resolve("tsx/esm");

async function withChild(
  fixture: "signal" | "deadline",
  deadlineMs: number | null,
  check: (input: {
    child: ReturnType<typeof spawn>;
    exited: Promise<[number | null, NodeJS.Signals | null]>;
    tracePath: string;
    waitFor: (message: string) => Promise<void>;
  }) => Promise<void>,
) {
  const tracePath = join(tmpdir(), `observability-${crypto.randomUUID()}.log`);
  const fixturePath = fileURLToPath(
    new URL(`./__tests__/observability-${fixture}-child.ts`, import.meta.url),
  );
  const child = spawn(process.execPath, ["--import", loader, fixturePath, tracePath], {
    cwd: serverDirectory,
    env:
      deadlineMs === null
        ? process.env
        : { ...process.env, SHUTDOWN_DEADLINE_MS: String(deadlineMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  async function waitFor(message: string) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
      };
      const onData = () => {
        if (stdout.includes(message)) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(`Shutdown fixture exited before ${message}: ${code}/${signal}\n${stderr}`),
        );
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Shutdown fixture never reported ${message}\n${stderr}`));
      }, 80_000);
      child.stdout?.on("data", onData);
      child.on("exit", onExit);
      child.on("error", onError);
      if (child.exitCode !== null) onExit(child.exitCode, child.signalCode);
      else onData();
    });
  }

  try {
    await waitFor("ready\n");
    await check({ child, exited, tracePath, waitFor });
    if (stderr) throw new Error(stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(tracePath, { force: true });
  }
}

describe("process shutdown hooks", () => {
  it("starts every drain on SIGTERM before a hung callback reaches the process deadline", async () => {
    await withChild("deadline", 100, async ({ child, exited, tracePath }) => {
      const signalledAt = Date.now();
      child.kill("SIGTERM");
      expect(await exited).toEqual([0, null]);
      expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(75);
      expect(new Set((await readFile(tracePath, "utf8")).trim().split("\n"))).toEqual(
        new Set(["runtime-drain-start", "rooms-drain-start"]),
      );
    });
  });

  it("drains a paid runtime turn once on SIGTERM and flushes before exit", async () => {
    await withChild("signal", null, async ({ child, exited, tracePath }) => {
      child.kill("SIGTERM");
      expect(await exited).toEqual([0, null]);
      const trace = (await readFile(tracePath, "utf8")).trim().split("\n");
      expect(trace.filter((event) => event === "settle-paid-response:1")).toHaveLength(1);
      expect(trace).toContain("reply-error-shutdown:shutdown:This response failed.");
      expect(trace).toContain("acknowledge-adopted-message:true");
      expect(trace.at(-1)).toBe("flush");
    });
  }, 90_000);

  it("forces exit on a second signal while a drain is still running", async () => {
    await withChild("deadline", 60_000, async ({ child, exited, tracePath, waitFor }) => {
      child.kill("SIGTERM");
      await waitFor("draining\n");
      child.kill("SIGINT");
      expect(await exited).toEqual([1, null]);
      expect(await readFile(tracePath, "utf8")).not.toContain("flush");
    });
  });
});
