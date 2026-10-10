import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_RAIL_PREFS,
  normalizeRailPrefs,
  useProjectSurfacePrefsStore,
} from "./surface-prefs-store";

afterEach(() => vi.unstubAllGlobals());

it("restores Scratch expansion and height and Recent expansion together", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const store = useProjectSurfacePrefsStore;
  store.getState().setRailExpanded("scratch", true);
  store.getState().setScratchHeight(234);
  store.getState().setRailExpanded("recent", false);
  const saved = values.get("meridian:project-surface-layout") ?? "";
  expect(JSON.parse(saved).version).toBe(4);
  // A cold store on reload or in another tab adopts the device preference.
  store.setState({ railPrefs: DEFAULT_RAIL_PREFS });
  values.set("meridian:project-surface-layout", saved);
  await store.persist.rehydrate();
  expect(store.getState().railPrefs).toEqual({
    scratchExpanded: true,
    recentExpanded: false,
    scratchHeight: 234,
  });
});

it("keeps layout actions usable in memory when storage fails", async () => {
  vi.stubGlobal("window", {
    get localStorage() {
      throw Error("blocked");
    },
  });
  await useProjectSurfacePrefsStore.persist.rehydrate();
  expect(() => {
    useProjectSurfacePrefsStore.getState().setRailExpanded("scratch", true);
    useProjectSurfacePrefsStore.getState().setScratchHeight(200);
    useProjectSurfacePrefsStore.getState().setDockWidth(400);
  }).not.toThrow();
  expect(useProjectSurfacePrefsStore.getState().railPrefs.scratchHeight).toBe(200);
});

it("rejects malformed rail preferences", () => {
  expect(normalizeRailPrefs({ scratchHeight: Number.NaN })).toEqual(DEFAULT_RAIL_PREFS);
});
