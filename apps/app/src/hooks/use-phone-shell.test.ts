// @ts-nocheck
/**
 * use-phone-shell tests — executable coverage for the device predicate that
 * decides whether WorkbenchView mounts the phone or desktop shell.
 */
import { describe, expect, it } from "vitest";

import { matchesPhoneShellViewport, PHONE_SHELL_QUERY } from "./use-phone-shell";

describe("PHONE_SHELL_QUERY", () => {
  it("uses a comma-separated media query list for portrait and landscape phones", () => {
    expect(PHONE_SHELL_QUERY).toBe(
      "(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 500px)",
    );
  });

  it.each([
    [{ width: 767, height: 900, pointer: "coarse" as const }, true],
    [{ width: 768, height: 900, pointer: "coarse" as const }, false],
    [{ width: 852, height: 393, pointer: "coarse" as const }, true],
    [{ width: 1133, height: 744, pointer: "coarse" as const }, false],
    [{ width: 500, height: 900, pointer: "fine" as const }, false],
  ])("matches %o as %s", (viewport, expected) => {
    expect(matchesPhoneShellViewport(viewport)).toBe(expected);
  });
});
