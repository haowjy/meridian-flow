/**
 * Surface prefs store behavior.
 */
import { afterEach, expect, it, vi } from "vitest";
import { useProjectSurfacePrefsStore } from "./surface-prefs-store";

afterEach(() => vi.unstubAllGlobals());

it("keeps layout actions usable in memory when storage fails", async () => {
  vi.stubGlobal("window", {
    get localStorage() {
      throw Error("blocked");
    },
  });
  await useProjectSurfacePrefsStore.persist.rehydrate();
  expect(() => {
    useProjectSurfacePrefsStore.getState().setSlotWidth("side", 400);
  }).not.toThrow();
  expect(useProjectSurfacePrefsStore.getState().widths.side).toBe(400);
});
