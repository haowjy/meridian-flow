/** Native-lock adapter serializes dispatch briefly and respects account shutdown. */

import { expect, it, vi } from "vitest";
import { type CrossContextLockManager, deferred } from "@/core/cross-context-locks";
import { createResourceNamespaceLock } from "./resource-namespace-lock";

class FaithfulLocks implements CrossContextLockManager {
  private readonly held = new Set<string>();

  async request<T>(
    name: string,
    _options: { mode?: "shared" | "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

it("allows only one concurrent resource dispatch", async () => {
  const epoch = new AbortController();
  const lock = createResourceNamespaceLock({
    accountId: "account",
    epoch: epoch.signal,
    locks: new FaithfulLocks(),
  });
  const release = deferred<void>();
  const first = lock.run({ projectId: "project", handle: "resource" }, async () => {
    await release.promise;
    return "done";
  });
  await expect(
    lock.run({ projectId: "project", handle: "resource" }, async () => "duplicate"),
  ).resolves.toEqual({ kind: "busy" });
  release.resolve();
  await expect(first).resolves.toEqual({ kind: "acquired", value: "done" });
});

it("blocks unavailable native locks and account-close admission", async () => {
  const epoch = new AbortController();
  const unavailable = createResourceNamespaceLock({
    accountId: "account",
    epoch: epoch.signal,
    locks: null,
  });
  const task = vi.fn(async () => "unsafe");
  await expect(
    unavailable.run({ projectId: "project", handle: "resource" }, task),
  ).resolves.toEqual({ kind: "busy" });
  expect(task).not.toHaveBeenCalled();
  epoch.abort();
  await expect(unavailable.run({ projectId: "project", handle: "resource" }, task)).rejects.toThrow(
    "closing",
  );
});
