/** Authenticated account-settings loading must never hold up page rendering. */
import { describe, expect, it, vi } from "vitest";
import { loadAccountSettingsWithDeadline } from "./authenticated-account-settings";

describe("loadAccountSettingsWithDeadline", () => {
  it("falls back when the settings request never settles", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}));

    const result = loadAccountSettingsWithDeadline(load, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual({ workingSetSyncEnabled: true });
    expect(load.mock.calls[0]?.[0]?.aborted).toBe(true);
    consoleError.mockRestore();
    vi.useRealTimers();
  });
});
