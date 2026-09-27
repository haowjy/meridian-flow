import { describe, expect, it } from "vitest";
import { statusFromSources } from "./run-model";

describe("saved and live run status", () => {
  it("never treats a saved running card without a live lease as still running", () => {
    expect(statusFromSources({ savedRunning: true, endedAt: "2026-09-26T00:00:00Z" })).toBe(
      "unknown",
    );
    expect(statusFromSources({ savedRunning: true })).toBe("unknown");
  });

  it("uses terminal truth before a potentially stale live lease", () => {
    expect(statusFromSources({ outcome: "succeeded", live: true })).toBe("done");
    expect(statusFromSources({ outcome: "failed", live: true })).toBe("stopped");
    expect(statusFromSources({ live: true })).toBe("running");
  });

  it("keeps unrecognized lifecycle information neutral", () => {
    expect(statusFromSources({})).toBe("unknown");
    expect(statusFromSources({ outcome: "pending" })).toBe("unknown");
  });
});
