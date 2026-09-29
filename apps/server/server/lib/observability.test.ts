import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const signalChild = fileURLToPath(
  new URL("./__tests__/observability-signal-child.ts", import.meta.url),
);
const deadlineChild = fileURLToPath(
  new URL("./__tests__/observability-deadline-child.ts", import.meta.url),
);
const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));

describe("process shutdown hooks", () => {
  it("starts every drain before a hung callback reaches the process deadline", async () => {
    const tracePath = join(tmpdir(), `observability-deadline-${crypto.randomUUID()}.log`);
    const child = spawn(process.execPath, ["--import", "tsx/esm", deadlineChild, tracePath], {
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
      const signalledAt = Date.now();
      child.kill("SIGTERM");
      const [exitCode, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null });
      expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(75);
      expect(Date.now() - signalledAt).toBeLessThan(2_000);
      if (stderr) throw new Error(stderr);
      expect((await readFile(tracePath, "utf8")).trim().split("\n")).toEqual([
        "runtime-drain-start",
        "yjs-drain-start",
      ]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(tracePath, { force: true });
    }
  });

  it.each([
    "SIGTERM",
    "SIGINT",
  ] as const)("drains once on %s and flushes before exit", async (signalName) => {
    const tracePath = join(tmpdir(), `observability-shutdown-${crypto.randomUUID()}.log`);
    const child = spawn(process.execPath, ["--import", "tsx/esm", signalChild, tracePath], {
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
      child.kill(signalName);
      const [exitCode, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null });
      if (stderr) throw new Error(stderr);
      expect((await readFile(tracePath, "utf8")).trim().split("\n")).toEqual([
        "begin-shutdown",
        "abort:shutdown",
        "drain-start",
        "drain-settled:true",
        "settle-paid-response:1",
        "reply-error-shutdown:shutdown:This reply was interrupted.",
        "acknowledge-adopted-message:true",
        "flush",
      ]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(tracePath, { force: true });
    }
  });

  it.each([
    ["SIGTERM", "SIGTERM"],
    ["SIGINT", "SIGINT"],
    ["SIGTERM", "SIGINT"],
    ["SIGINT", "SIGTERM"],
  ] as const)("forces exit when %s is followed by %s", async (first, second) => {
    const tracePath = join(tmpdir(), `observability-force-exit-${crypto.randomUUID()}.log`);
    const child = spawn(process.execPath, ["--import", "tsx/esm", signalChild, tracePath], {
      cwd: serverDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    try {
      await expect.poll(() => stdout, { timeout: 5_000 }).toContain("ready");
      child.kill(first);
      await expect
        .poll(() => readFile(tracePath, "utf8").catch(() => ""), { timeout: 5_000 })
        .toContain("drain-start");
      child.kill(second);
      const [exitCode, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect({ exitCode, signal }).toEqual({ exitCode: 1, signal: null });
      expect(await readFile(tracePath, "utf8")).not.toContain("flush");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(tracePath, { force: true });
    }
  });
});
