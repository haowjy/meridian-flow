import { describe, expect, it, vi } from "vitest";
import { runBackgroundRetrieval } from "@/core/retrieval";

describe("runBackgroundRetrieval", () => {
  it("uses initial mode when there is no cached data", async () => {
    const onBegin = vi.fn();
    const onSuccess = vi.fn();

    await runBackgroundRetrieval({
      hasCachedData: false,
      onBegin,
      retrieve: async () => ["a", "b"],
      onSuccess,
      onError: vi.fn(),
    });

    expect(onBegin).toHaveBeenCalledWith("initial");
    expect(onSuccess).toHaveBeenCalledWith(["a", "b"], "initial");
  });

  it("routes abort errors to onAbort", async () => {
    const onAbort = vi.fn();
    const onError = vi.fn();

    await runBackgroundRetrieval({
      hasCachedData: true,
      onBegin: vi.fn(),
      retrieve: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
      onSuccess: vi.fn(),
      onError,
      onAbort,
    });

    expect(onAbort).toHaveBeenCalledWith("background");
    expect(onError).not.toHaveBeenCalled();
  });

  it("skips completion callbacks for stale requests", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await runBackgroundRetrieval({
      hasCachedData: false,
      isStale: () => true,
      onBegin: vi.fn(),
      retrieve: async () => "data",
      onSuccess,
      onError,
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
