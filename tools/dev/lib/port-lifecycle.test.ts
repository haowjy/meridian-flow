/** Local port liveness + wait-for-free coverage for deterministic restarts (issue #331). */

import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalPortFree, releaseFixedPorts, waitForPortsFree } from "./port-lifecycle";

const MOCK_PORT = 12_345;
const servers: net.Server[] = [];

function listenOnEphemeralPort(): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("failed to resolve ephemeral port"));
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function stubPortProbe(isHeld: () => boolean, afterHeldProbe?: () => void): void {
  // Model bind outcomes so release checks never race with another process reusing a freed port.
  vi.spyOn(net, "createServer").mockImplementation(() => {
    const probe = new EventEmitter() as unknown as net.Server;
    probe.listen = ((_options: net.ListenOptions, listeningListener?: () => void): net.Server => {
      queueMicrotask(() => {
        if (isHeld()) {
          probe.emit("error", Object.assign(new Error("address in use"), { code: "EADDRINUSE" }));
          afterHeldProbe?.();
        } else {
          listeningListener?.();
        }
      });
      return probe;
    }) as net.Server["listen"];
    probe.close = ((callback?: (error?: Error) => void): net.Server => {
      callback?.();
      return probe;
    }) as net.Server["close"];
    return probe;
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  vi.restoreAllMocks();
});

describe("isLocalPortFree", () => {
  it("reports a held port as not free", async () => {
    const port = await listenOnEphemeralPort();
    expect(await isLocalPortFree(port)).toBe(false);
  });
});

describe("waitForPortsFree", () => {
  it("returns held ports when they never release", async () => {
    const port = await listenOnEphemeralPort();
    const held = await waitForPortsFree([port], { timeoutMs: 150, intervalMs: 25 });
    expect(held).toEqual([port]);
  });

  it("resolves empty once the held port becomes free mid-wait", async () => {
    const port = MOCK_PORT;
    let held = true;
    stubPortProbe(
      () => held,
      () => {
        held = false;
      },
    );

    const remaining = await waitForPortsFree([port], { timeoutMs: 2_000, intervalMs: 25 });
    expect(remaining).toEqual([]);
  });
});

describe("releaseFixedPorts", () => {
  it("kills a surviving holder", async () => {
    const port = MOCK_PORT;
    let held = true;
    stubPortProbe(() => held);
    const holder = { pid: 1234, command: "vite" };
    const onKill = vi.fn();
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") held = false;
    });
    const result = await releaseFixedPorts([port], {
      intervalMs: 10,
      terminateTimeoutMs: 2_000,
      discoverHolders: () => ({
        ok: true,
        holders: [holder],
      }),
      killProcess,
      onKill,
    });

    expect(result).toEqual({
      status: "released",
      ports: [port],
    });
    expect(killProcess).toHaveBeenCalledWith(holder.pid, "SIGTERM");
    expect(onKill).toHaveBeenCalledOnce();
    expect(onKill).toHaveBeenCalledWith({ port, holder });
    expect(await isLocalPortFree(port)).toBe(true);
  });

  it("force-kills a holder that survives SIGTERM", async () => {
    const port = MOCK_PORT;
    let held = true;
    stubPortProbe(() => held);
    const holder = { pid: 1234, command: "vite" };
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") held = false;
    });

    await expect(
      releaseFixedPorts([port], {
        intervalMs: 10,
        terminateTimeoutMs: 0,
        forceTimeoutMs: 2_000,
        discoverHolders: () => ({ ok: true, holders: [holder] }),
        killProcess,
      }),
    ).resolves.toEqual({ status: "released", ports: [port] });

    expect(killProcess.mock.calls).toEqual([
      [holder.pid, "SIGTERM"],
      [holder.pid, "SIGKILL"],
    ]);
  });

  it("gives a replacement holder its own SIGTERM grace period", async () => {
    const port = MOCK_PORT;
    let held = true;
    stubPortProbe(() => held);
    const firstHolder = { pid: 1234, command: "vite-old" };
    const replacement = { pid: 5678, command: "vite-new" };
    let discoveryCount = 0;
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (_pid === replacement.pid && signal === "SIGKILL") {
        held = false;
      }
    });

    await expect(
      releaseFixedPorts([port], {
        intervalMs: 10,
        terminateTimeoutMs: 0,
        forceTimeoutMs: 2_000,
        discoverHolders: () => ({
          ok: true,
          holders: [discoveryCount++ === 0 ? firstHolder : replacement],
        }),
        killProcess,
      }),
    ).resolves.toEqual({ status: "released", ports: [port] });

    expect(killProcess.mock.calls).toEqual([
      [firstHolder.pid, "SIGTERM"],
      [replacement.pid, "SIGTERM"],
      [replacement.pid, "SIGKILL"],
    ]);
  });

  it("signals a holder discovered after SIGKILL before inspecting the port again", async () => {
    const port = MOCK_PORT;
    let held = true;
    stubPortProbe(() => held);
    const firstHolder = { pid: 1234, command: "vite-old" };
    const postKillHolder = { pid: 5678, command: "vite-post-kill" };
    const nextHolder = { pid: 9012, command: "vite-next" };
    const discoveries = [firstHolder, firstHolder, postKillHolder];
    let discoveryCount = 0;
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (_pid === nextHolder.pid && signal === "SIGKILL") {
        held = false;
      }
    });

    await expect(
      releaseFixedPorts([port], {
        intervalMs: 10,
        terminateTimeoutMs: 0,
        forceTimeoutMs: 100,
        discoverHolders: () => ({
          ok: true,
          holders: [discoveries[discoveryCount++] ?? nextHolder],
        }),
        killProcess,
      }),
    ).resolves.toEqual({ status: "released", ports: [port] });

    expect(killProcess.mock.calls).toEqual([
      [firstHolder.pid, "SIGTERM"],
      [firstHolder.pid, "SIGKILL"],
      [postKillHolder.pid, "SIGTERM"],
      [nextHolder.pid, "SIGTERM"],
      [nextHolder.pid, "SIGKILL"],
    ]);
  });

  it("reports discovery failure instead of treating an uninspectable holder as released", async () => {
    const port = MOCK_PORT;
    stubPortProbe(() => true);
    const result = await releaseFixedPorts([port], {
      discoverHolders: () => ({ ok: false, error: "lsof unavailable" }),
    });

    expect(result).toEqual({
      status: "discoveryError",
      errors: [{ port, error: "lsof unavailable" }],
    });
  });

  it("does not report discovery failure when the port frees during inspection", async () => {
    const port = MOCK_PORT;
    let held = true;
    stubPortProbe(() => held);
    const discoverHolders = vi.fn(() => {
      held = false;
      return { ok: false as const, error: "lsof exited with status 1" };
    });

    await expect(releaseFixedPorts([port], { discoverHolders })).resolves.toEqual({
      status: "released",
      ports: [port],
    });
    expect(discoverHolders).toHaveBeenCalledOnce();
  });

  it("does not inspect ports that are already free", async () => {
    const port = MOCK_PORT;
    stubPortProbe(() => false);
    const discoverHolders = vi.fn();

    await expect(releaseFixedPorts([port], { discoverHolders })).resolves.toEqual({
      status: "released",
      ports: [port],
    });
    expect(discoverHolders).not.toHaveBeenCalled();
  });
});
