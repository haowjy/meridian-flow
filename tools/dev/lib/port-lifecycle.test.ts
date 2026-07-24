/** Local port liveness + wait-for-free coverage for deterministic restarts (issue #331). */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
  it("reports a non-owned holder without killing it", async () => {
    const port = await listenOnEphemeralPort();
    const result = await releaseFixedPorts([port], {
      timeoutMs: 0,
      discoverHolders: () => ({
        ok: true,
        holders: [{ pid: process.pid, command: "vitest" }],
      }),
    });

    expect(result).toEqual({
      status: "stillHeld",
      held: [{ port, holders: [{ pid: process.pid, command: "vitest" }] }],
    });
    expect(await isLocalPortFree(port)).toBe(false);
  });

  it("reports discovery failure instead of treating an uninspectable holder as released", async () => {
    const port = await listenOnEphemeralPort();
    const result = await releaseFixedPorts([port], {
      timeoutMs: 0,
      discoverHolders: () => ({ ok: false, error: "lsof unavailable" }),
    });

    expect(result).toEqual({
      status: "discoveryError",
      errors: [{ port, error: "lsof unavailable" }],
    });
  });

  it("reports released only after every port is bindable", async () => {
    const port = await listenOnEphemeralPort();
    setTimeout(() => void closeServer(servers.pop() as net.Server), 40);

    await expect(releaseFixedPorts([port], { timeoutMs: 2_000, intervalMs: 25 })).resolves.toEqual({
      status: "released",
      ports: [port],
    });
  });
});
