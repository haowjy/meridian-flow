/** Retired project UI preferences no longer accept writes; runtime auto-resume remains. */
import { expect, it } from "vitest";
import { parseUpdateProjectPreferencesRequest } from "./project-preferences-route.js";

it("rejects retired thread preferences and retains the runtime policy", () => {
  expect(() => parseUpdateProjectPreferencesRequest({ threadGroupBy: "work" })).toThrow();
  expect(() => parseUpdateProjectPreferencesRequest({ pinnedThreadIds: [] })).toThrow();
  const autoResume = { enabled: false, timeoutMs: 12345 };
  expect(parseUpdateProjectPreferencesRequest({ autoResume })).toEqual({ autoResume });
  for (const value of [
    { enabled: false, timeoutMs: 0 },
    { enabled: "false", timeoutMs: 1 },
  ])
    expect(() => parseUpdateProjectPreferencesRequest({ autoResume: value })).toThrow();
});
