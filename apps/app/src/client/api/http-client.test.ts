/**
 * Contract test for the shared PATCH helper: the caller's abort signal (used by
 * the account-epoch fence) must reach `fetch`, not be dropped at the wrapper.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { patchJson } from "./http-client";

describe("patchJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the caller's abort signal to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ title: "Renamed" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await patchJson(
      "/api/threads/thread-1/title",
      { title: "Renamed" },
      {
        signal: controller.signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/threads/thread-1/title",
      expect.objectContaining({ method: "PATCH", signal: controller.signal }),
    );
  });
});
