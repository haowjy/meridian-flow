/**
 * Placement tests for the workbench surface layout model.
 *
 * Purpose: lock the pure screen-to-slot mapping, the center-non-collapsible
 * rule, and the shared-dock-pref overlay so that whichever surface lands in the
 * dock slot reads the single shared width/collapsed state. Key decision: these
 * tests exercise the functional core directly instead of component structure so
 * future shell refactors can keep the same layout contract.
 */
import { describe, expect, it } from "vitest";

import type { ScreenKey } from "../shell/screens";
import { mergeSurfaceLayout, placeSurfaces } from "./placement";
import {
  DEFAULT_DOCK_PREFS,
  DEFAULT_SURFACE_PREFS,
  migrateSurfacePrefsState,
  type SlotPrefsMap,
} from "./surface-prefs-store";
import type { SurfacePrefsMap } from "./types";

describe("workbench surface placement", () => {
  it("keeps each active slot owned by at most one surface", () => {
    const screens: ScreenKey[] = ["home", "chat", "context"];

    for (const screen of screens) {
      const activeSurfacesBySlot = new Map<string, string[]>();
      const layout = mergeSurfaceLayout(placeSurfaces(screen), DEFAULT_SURFACE_PREFS);

      for (const [surfaceId, surfaceLayout] of Object.entries(layout)) {
        if (!surfaceLayout.slot || surfaceLayout.collapsed) continue;
        const surfaces = activeSurfacesBySlot.get(surfaceLayout.slot) ?? [];
        surfaces.push(surfaceId);
        activeSurfacesBySlot.set(surfaceLayout.slot, surfaces);
      }

      for (const [slot, surfaces] of activeSurfacesBySlot) {
        expect(surfaces.length, `${screen}:${slot}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("maps each screen to the expected slots", () => {
    expect(placeSurfaces("home")).toMatchObject({
      threads: { slot: "rail-l" },
      chat: { slot: "dock" },
      "context-viewer": { slot: null },
      "context-rail": { slot: null },
    });

    expect(placeSurfaces("chat")).toMatchObject({
      threads: { slot: "rail-l" },
      chat: { slot: "center" },
      "context-rail": { slot: "dock" },
    });

    // The files explorer renders inside `ContextViewer`, not as a grid
    // slot; its prefs live in context/context-files-store.ts.
    expect(placeSurfaces("context")).toMatchObject({
      threads: { slot: "rail-l" },
      "context-viewer": { slot: "center" },
      chat: { slot: "dock" },
    });
  });

  it("merges prefs while forcing center surfaces expanded", () => {
    const prefs: SurfacePrefsMap = {
      ...DEFAULT_SURFACE_PREFS,
      chat: { ...DEFAULT_SURFACE_PREFS.chat, collapsed: true },
    };
    // The dock occupant reads the shared dock pref, not the surface's own.
    const slotPrefs: SlotPrefsMap = { dock: { width: 360, collapsed: true } };

    const layout = mergeSurfaceLayout(placeSurfaces("chat"), prefs, slotPrefs);

    expect(layout.chat).toMatchObject({
      slot: "center",
      width: DEFAULT_SURFACE_PREFS.chat.width,
      collapsed: false,
    });
    expect(layout["context-rail"]).toMatchObject({
      slot: "dock",
      width: slotPrefs.dock.width,
      collapsed: true,
    });
  });

  it("falls back to defaults when prefs are missing or partial", () => {
    expect(() => mergeSurfaceLayout(placeSurfaces("chat"), {} as SurfacePrefsMap)).not.toThrow();

    const layout = mergeSurfaceLayout(placeSurfaces("chat"), {
      chat: { collapsed: true },
    } as SurfacePrefsMap);

    expect(layout.chat).toMatchObject({
      slot: "center",
      width: DEFAULT_SURFACE_PREFS.chat.width,
      collapsed: false,
    });
    expect(layout.threads).toMatchObject({
      width: DEFAULT_SURFACE_PREFS.threads.width,
      collapsed: DEFAULT_SURFACE_PREFS.threads.collapsed,
    });
    // context-rail is the dock occupant on the chat screen — it now picks up
    // the default dock pref, not its own surface pref.
    expect(layout["context-rail"]).toMatchObject({
      width: DEFAULT_DOCK_PREFS.width,
      collapsed: DEFAULT_DOCK_PREFS.collapsed,
    });
  });

  it("shares one dock width and collapsed state across screens", () => {
    const prefs = DEFAULT_SURFACE_PREFS;
    const slotPrefs: SlotPrefsMap = { dock: { width: 412, collapsed: false } };

    const chatLayout = mergeSurfaceLayout(placeSurfaces("chat"), prefs, slotPrefs);
    const contextLayout = mergeSurfaceLayout(placeSurfaces("context"), prefs, slotPrefs);
    const homeLayout = mergeSurfaceLayout(placeSurfaces("home"), prefs, slotPrefs);

    // chat screen: context-rail is in the dock
    expect(chatLayout["context-rail"]).toMatchObject({
      slot: "dock",
      width: 412,
      collapsed: false,
    });
    // context + home screens: chat is in the dock — same width + collapsed
    expect(contextLayout.chat).toMatchObject({ slot: "dock", width: 412, collapsed: false });
    expect(homeLayout.chat).toMatchObject({ slot: "dock", width: 412, collapsed: false });

    // Collapse via the shared dock pref applies to every occupant.
    const collapsed: SlotPrefsMap = { dock: { width: 412, collapsed: true } };
    const chatCollapsed = mergeSurfaceLayout(placeSurfaces("chat"), prefs, collapsed);
    const contextCollapsed = mergeSurfaceLayout(placeSurfaces("context"), prefs, collapsed);
    expect(chatCollapsed["context-rail"].collapsed).toBe(true);
    expect(contextCollapsed.chat.collapsed).toBe(true);
  });

  it("ignores the docked surface's own width/collapsed pref", () => {
    // Even when the surface's own prefs say collapsed/narrow, the dock pref wins.
    const prefs: SurfacePrefsMap = {
      ...DEFAULT_SURFACE_PREFS,
      chat: { width: 280, collapsed: true },
      "context-rail": { width: 240, collapsed: true },
    };
    const slotPrefs: SlotPrefsMap = { dock: { width: 440, collapsed: false } };

    const chatLayout = mergeSurfaceLayout(placeSurfaces("chat"), prefs, slotPrefs);
    const contextLayout = mergeSurfaceLayout(placeSurfaces("context"), prefs, slotPrefs);

    expect(chatLayout["context-rail"]).toMatchObject({ width: 440, collapsed: false });
    expect(contextLayout.chat).toMatchObject({ width: 440, collapsed: false });
  });

  it("migrates legacy assignment persistence into complete surface prefs", () => {
    const migrated = migrateSurfacePrefsState(
      {
        assignments: {
          chat: { slot: "dock", width: 444, collapsed: true },
          threads: { slot: "rail-l", width: 300, collapsed: false },
        },
      },
      0,
    );

    expect(migrated.prefs.chat).toEqual({ width: 444, collapsed: true });
    expect(migrated.prefs.threads).toEqual({ width: 300, collapsed: false });
    expect(migrated.prefs["context-viewer"]).toEqual(DEFAULT_SURFACE_PREFS["context-viewer"]);
    expect(migrated.prefs["context-rail"]).toEqual(DEFAULT_SURFACE_PREFS["context-rail"]);
    // v0 → v2: dock pref seeded from chat (the prior right-rail surface).
    expect(migrated.slotPrefs.dock).toEqual({ width: 444, collapsed: true });
  });

  it("seeds the shared dock pref from chat when migrating from v1", () => {
    const migrated = migrateSurfacePrefsState(
      {
        prefs: {
          chat: { width: 408, collapsed: true },
          "context-rail": { width: 300, collapsed: false },
        },
      },
      1,
    );

    expect(migrated.prefs.chat).toEqual({ width: 408, collapsed: true });
    // Dock seed comes from chat (the prior right-rail muscle memory).
    expect(migrated.slotPrefs.dock).toEqual({ width: 408, collapsed: true });
  });

  it("falls back to context-rail when chat was not persisted at v1", () => {
    const migrated = migrateSurfacePrefsState(
      {
        prefs: {
          "context-rail": { width: 296, collapsed: false },
        },
      },
      1,
    );

    expect(migrated.slotPrefs.dock).toEqual({ width: 296, collapsed: false });
  });

  it("keeps the persisted dock pref verbatim at v3", () => {
    const migrated = migrateSurfacePrefsState(
      {
        prefs: { chat: { width: 380, collapsed: false } },
        slotPrefs: { dock: { width: 472, collapsed: true } },
      },
      3,
    );

    expect(migrated.slotPrefs.dock).toEqual({ width: 472, collapsed: true });
  });

  it("drops context-files during v2→v3 migration (value must be harvested first)", () => {
    // v2→v3 migration: the legacy blob may still contain
    // prefs["context-files"]; normalizeSurfacePrefs only writes ids in
    // WORKBENCH_SURFACE_IDS, so the key falls away without error. This is
    // correct ONLY because seedContextFilesPanelFromLegacy() (in
    // context/context-files-store.ts) harvests the value BEFORE this
    // migration runs — see context-files-store.test.ts upgrade-path test
    // that guards the call order.
    const migrated = migrateSurfacePrefsState(
      {
        prefs: {
          chat: { width: 380, collapsed: false },
          "context-files": { width: 248, collapsed: true },
        },
      },
      2,
    );

    expect(migrated.prefs.chat).toEqual({ width: 380, collapsed: false });
    // context-files is gone — it's not in WORKBENCH_SURFACE_IDS anymore.
    // The workbench store is correct to drop it; the new context-files-panel
    // store must already own the value by the time this migration executes.
    expect(migrated.prefs).not.toHaveProperty("context-files");
    // context-viewer and context-rail still land at defaults.
    expect(migrated.prefs["context-viewer"]).toEqual(DEFAULT_SURFACE_PREFS["context-viewer"]);
    expect(migrated.prefs["context-rail"]).toEqual(DEFAULT_SURFACE_PREFS["context-rail"]);
  });
});
