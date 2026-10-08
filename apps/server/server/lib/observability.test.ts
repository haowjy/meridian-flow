/** Real process signals must settle paid runtime work before flushing and exiting. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
// Resolve the loader from this installed worktree, independent of the child's cwd.
const loader = import.meta.resolve("tsx/esm");

async function withChild(
  fixture: "signal" | "deadline",
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
      // Startup imports are separate from the production drain deadline asserted below.
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Shutdown fixture never reported ${message}\n${stderr}`));
      }, 10_000);
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
  it("starts every drain before a hung callback reaches the process deadline", async () => {
    await withChild("deadline", async ({ child, exited, tracePath }) => {
      const signalledAt = Date.now();
      child.kill("SIGTERM");
      expect(await exited).toEqual([0, null]);
      expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(75);
      expect(Date.now() - signalledAt).toBeLessThan(2_000);
      expect((await readFile(tracePath, "utf8")).trim().split("\n")).toEqual([
        "runtime-drain-start",
        "yjs-drain-start",
      ]);
    });
  });

  it.each([
    "SIGTERM",
    "SIGINT",
  ] as const)("drains once on %s and flushes before exit", async (signalName) => {
    await withChild("signal", async ({ child, exited, tracePath }) => {
      child.kill(signalName);
      expect(await exited).toEqual([0, null]);
      expect((await readFile(tracePath, "utf8")).trim().split("\n")).toEqual([
        "begin-shutdown",
        "abort:shutdown",
        "drain-start",
        "drain-settled:true",
        "settle-paid-response:1",
        "reply-error-shutdown:shutdown:This response failed.",
        "acknowledge-adopted-message:true",
        "flush",
      ]);
    });
  });

  it("forces exit on a second signal while settlement is still draining", async () => {
    await withChild("signal", async ({ child, exited, tracePath, waitFor }) => {
      child.kill("SIGTERM");
      await waitFor("draining\n");
      child.kill("SIGINT");
      expect(await exited).toEqual([1, null]);
      expect(await readFile(tracePath, "utf8")).not.toContain("flush");
    });
  });
});
