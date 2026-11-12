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
  type RailPrefs,
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
    useProjectSurfacePrefsStore.getState().setSlotWidth("side", 400);
  }).not.toThrow();
  expect(useProjectSurfacePrefsStore.getState().railPrefs.scratchExpanded).toBe(true);
});

it("rejects malformed rail preferences", () => {
  expect(normalizeRailPrefs({ scratchExpanded: "yes" } as unknown as Partial<RailPrefs>)).toEqual(
    DEFAULT_RAIL_PREFS,
  );
});
