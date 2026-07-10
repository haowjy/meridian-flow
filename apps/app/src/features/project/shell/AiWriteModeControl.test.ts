/**
 * AiWriteModeControl confirm-and-push logic (spec §3.4).
 *
 * Guards the two invariants the popover must never break: it appears only when
 * leaving Draft with content-bearing pending changes, and the N it shows is the
 * content-aware count shared with the dock.
 */
import { describe, expect, it } from "vitest";

import { confirmPushCount, shouldConfirmPush } from "./AiWriteModeControl";

describe("shouldConfirmPush", () => {
  it("confirms only when leaving Draft with pending changes", () => {
    expect(shouldConfirmPush("draft", 12)).toBe(true);
    expect(shouldConfirmPush("draft", 1)).toBe(true);
  });

  it("flips freely with no pending changes (N = 0 is silent, §3.4)", () => {
    expect(shouldConfirmPush("draft", 0)).toBe(false);
    expect(shouldConfirmPush("draft", null)).toBe(false);
  });

  it("never confirms when already in Auto-apply", () => {
    expect(shouldConfirmPush("direct", 12)).toBe(false);
    expect(shouldConfirmPush("direct", 0)).toBe(false);
  });
});

describe("confirmPushCount", () => {
  it("preserves the shared content-aware count", () => {
    // The popover copy and the `Apply N and switch` button both read this one
    // derivation, so the two confirmation labels cannot drift.
    for (const pending of [1, 2, 12, 137]) {
      expect(confirmPushCount(pending)).toBe(pending);
    }
  });

  it("collapses an unknown/absent count to 0 (no confirm shown)", () => {
    expect(confirmPushCount(null)).toBe(0);
  });
});
