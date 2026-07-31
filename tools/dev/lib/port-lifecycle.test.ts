/** Local port liveness + wait-for-free coverage for deterministic restarts (issue #331). */
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalPortFree, releaseFixedPorts, waitForPortsFree } from "./port-lifecycle";

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

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("isLocalPortFree", () => {
  it("reports a held port as not free and a released port as free", async () => {
    const port = await listenOnEphemeralPort();
    expect(await isLocalPortFree(port)).toBe(false);

    await closeServer(servers.pop() as net.Server);
    expect(await isLocalPortFree(port)).toBe(true);
  });
});

describe("waitForPortsFree", () => {
  it("returns held ports when they never release", async () => {
    const port = await listenOnEphemeralPort();
    const held = await waitForPortsFree([port], { timeoutMs: 150, intervalMs: 25 });
    expect(held).toEqual([port]);
  });

  it("resolves empty once the port is released mid-wait", async () => {
    const port = await listenOnEphemeralPort();
    setTimeout(() => void closeServer(servers.pop() as net.Server), 40);
    const held = await waitForPortsFree([port], { timeoutMs: 2_000, intervalMs: 25 });
    expect(held).toEqual([]);
  });

  it("treats an empty port list as immediately free", async () => {
    expect(await waitForPortsFree([])).toEqual([]);
  });
});

describe("releaseFixedPorts", () => {
  it("kills a surviving holder", async () => {
    const port = await listenOnEphemeralPort();
    const holder = { pid: 1234, command: "vite" };
    const onKill = vi.fn();
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        void closeServer(servers.pop() as net.Server);
      }
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
    const port = await listenOnEphemeralPort();
    const holder = { pid: 1234, command: "vite" };
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        void closeServer(servers.pop() as net.Server);
      }
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
    const port = await listenOnEphemeralPort();
    const firstHolder = { pid: 1234, command: "vite-old" };
    const replacement = { pid: 5678, command: "vite-new" };
    let discoveryCount = 0;
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (_pid === replacement.pid && signal === "SIGKILL") {
        void closeServer(servers.pop() as net.Server);
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

  it("reports discovery failure instead of treating an uninspectable holder as released", async () => {
    const port = await listenOnEphemeralPort();
    const result = await releaseFixedPorts([port], {
      discoverHolders: () => ({ ok: false, error: "lsof unavailable" }),
    });

    expect(result).toEqual({
      status: "discoveryError",
      errors: [{ port, error: "lsof unavailable" }],
    });
  });

  it("does not report discovery failure when the port frees during inspection", async () => {
    const port = await listenOnEphemeralPort();
    const discoverHolders = vi.fn(() => {
      void closeServer(servers.pop() as net.Server);
      return { ok: false as const, error: "lsof exited with status 1" };
    });

    await expect(releaseFixedPorts([port], { discoverHolders })).resolves.toEqual({
      status: "released",
      ports: [port],
    });
    expect(discoverHolders).toHaveBeenCalledOnce();
  });

  it("does not inspect ports that are already free", async () => {
    const port = await listenOnEphemeralPort();
    await closeServer(servers.pop() as net.Server);
    const discoverHolders = vi.fn();

    await expect(releaseFixedPorts([port], { discoverHolders })).resolves.toEqual({
      status: "released",
      ports: [port],
    });
    expect(discoverHolders).not.toHaveBeenCalled();
  });
});
