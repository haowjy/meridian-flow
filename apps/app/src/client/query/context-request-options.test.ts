import { describe, expect, it } from "vitest";
import { contextRequestOptionsForScheme } from "./context-request-options";

describe("context request ownership", () => {
  it.each([
    "manuscript",
    "kb",
    "user",
  ] as const)("omits Editor Work authority for project-scoped %s requests", (scheme) => {
    expect(contextRequestOptionsForScheme(scheme, "work-a")).toBeUndefined();
  });

  it.each([
    "scratch",
    "uploads",
  ] as const)("includes Editor Work authority for Work-scoped %s requests", (scheme) => {
    expect(contextRequestOptionsForScheme(scheme, "work-a")).toEqual({ workId: "work-a" });
  });
});
