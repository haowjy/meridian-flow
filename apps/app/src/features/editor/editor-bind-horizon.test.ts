/** Bind-horizon sequencing: all available evidence sources share one timeout. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForEditorBindHorizon } from "./editor-bind-horizon";

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForEditorBindHorizon", () => {
  it("resolves only after local persistence and the first server sync", async () => {
    let resolvePersistence!: () => void;
    let resolveServer!: () => void;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    const server = new Promise<void>((resolve) => {
      resolveServer = resolve;
    });
    let result: { evidenceDegraded: boolean } | undefined;
    const horizon = waitForEditorBindHorizon({
      localPersistence: persistence,
      firstServerSync: server,
      timeoutMs: 5_000,
    }).then((next) => {
      result = next;
    });

    resolvePersistence();
    await Promise.resolve();
    expect(result).toBeUndefined();
    resolveServer();
    await horizon;

    expect(result).toEqual({ evidenceDegraded: false });
  });

  it("binds with degraded evidence when the one overall timeout expires", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const horizon = waitForEditorBindHorizon({
      localPersistence: never,
      firstServerSync: never,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void horizon.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(horizon).resolves.toEqual({ evidenceDegraded: true });
  });

  it("waits for the remaining evidence source after another source rejects", async () => {
    vi.useFakeTimers();
    let resolvePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    let result: { evidenceDegraded: boolean } | undefined;
    const horizon = waitForEditorBindHorizon({
      localPersistence: persistence,
      firstServerSync: Promise.reject(new Error("transport failed")),
      timeoutMs: 5_000,
    }).then((next) => {
      result = next;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(result).toBeUndefined();

    resolvePersistence();
    await horizon;
    expect(result).toEqual({ evidenceDegraded: true });
  });
});
