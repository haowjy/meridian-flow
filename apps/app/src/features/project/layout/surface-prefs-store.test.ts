/**
 * Surface prefs store behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - project rail preference persistence
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_RAIL_PREFS,
  normalizeRailPrefs,
  useProjectSurfacePrefsStore,
} from "./surface-prefs-store";

afterEach(() => vi.unstubAllGlobals());

it("keeps layout actions usable in memory when storage fails", async () => {
  vi.stubGlobal("window", {
    get localStorage() {
      throw Error("blocked");
    },
  });
  await useProjectSurfacePrefsStore.persist.rehydrate();
  expect(() => {
    useProjectSurfacePrefsStore.getState().setRailExpanded("scratch", true);
    useProjectSurfacePrefsStore.getState().setRailHeight("scratch", 200);
    useProjectSurfacePrefsStore.getState().setDockWidth(400);
  }).not.toThrow();
  expect(useProjectSurfacePrefsStore.getState().railPrefs.scratchHeight).toBe(200);
});

it("rejects malformed rail preferences", () => {
  expect(normalizeRailPrefs({ scratchHeight: Number.NaN })).toEqual(DEFAULT_RAIL_PREFS);
});
