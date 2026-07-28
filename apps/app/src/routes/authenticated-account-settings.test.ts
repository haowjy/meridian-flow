/** Authenticated account-settings loading must never hold up page rendering. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAccountSettingsWithDeadline } from "./authenticated-account-settings";

describe("loadAccountSettingsWithDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("disables sync when the settings request never settles", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}));

    const result = loadAccountSettingsWithDeadline(load, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBeNull();
    expect(load.mock.calls[0]?.[0]?.aborted).toBe(true);
  });

  it("disables sync when the settings request rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      loadAccountSettingsWithDeadline(() => Promise.reject(new Error("unavailable"))),
    ).resolves.toBeNull();
  });
});
