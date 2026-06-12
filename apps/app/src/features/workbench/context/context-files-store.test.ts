// @ts-nocheck
/**
 * Context files store — upgrade-path and seed tests.
 *
 * Verifies the data-preservation contract: when splitting context-files panel
 * prefs out of the shared workbench surface-layout store, the seed MUST read
 * the legacy blob BEFORE the workbench v2→v3 migration rewrites it (the
 * migration drops prefs["context-files"] and writes back immediately via
 * zustand persist).
 *
 * The route `_authenticated.tsx` relies on this order. This test guards it.
 *
 * Test strategy: seedContextFilesPanelFromLegacy() reads localStorage at call
 * time (not at import time), so we stub localStorage in each test. The store's
 * setters work without the persist middleware attached (zustand falls back to
 * in-memory setState when storage is unavailable). We don't need
 * persist.rehydrate() for the core order-sensitive behaviour — the seed IS
 * the hydrating step for the new store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSurfacePrefsState } from "../layout/surface-prefs-store";
import { seedContextFilesPanelFromLegacy, useContextFilesPanelStore } from "./context-files-store";

// ---- helpers ----

function createMockLocalStorage() {
  const store = new Map<string, string>();
  return {
    store,
    ls: {
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, value);
      },
      removeItem(key: string) {
        store.delete(key);
      },
      clear() {
        store.clear();
      },
      get length() {
        return store.size;
      },
      key(index: number) {
        return [...store.keys()][index] ?? null;
      },
    },
  };
}

function resetContextFilesStore() {
  useContextFilesPanelStore.setState({ width: 220, collapsed: false });
}

/**
 * Build a realistic v2 persistent blob as laid down by zustand persist v4.
 * Matches the shape the workbench store's `migrate` function expects:
 * `{ state: { prefs: { ... }, slotPrefs: { dock: ... } }, version: 2 }`
 */
function makeV2Blob(contextFiles?: { width?: number; collapsed?: boolean }) {
  return {
    state: {
      prefs: {
        threads: { width: 264, collapsed: false },
        chat: { width: 360, collapsed: false },
        "context-viewer": { width: 0, collapsed: true },
        "context-rail": { width: 320, collapsed: true },
        "context-files": {
          width: contextFiles?.width ?? 300,
          collapsed: contextFiles?.collapsed ?? true,
        },
      },
      slotPrefs: { dock: { width: 360, collapsed: false } },
    },
    version: 2,
  };
}

// ---- tests ----

describe("context-files-store upgrade path", () => {
  beforeEach(() => {
    resetContextFilesStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetContextFilesStore();
  });

  it("preserves context-files prefs when seed runs BEFORE workbench migrate (correct order)", () => {
    const { store, ls } = createMockLocalStorage();
    vi.stubGlobal("localStorage", ls);

    // Pre-upgrade state: v2 workbench blob with saved files-panel prefs.
    store.set(
      "meridian:workbench-surface-layout",
      JSON.stringify(makeV2Blob({ width: 300, collapsed: true })),
    );
    // New key absent (pre-upgrade).
    expect(store.has("meridian:context-files-panel")).toBe(false);

    // CORRECT order — matches _authenticated.tsx after the fix.
    // 1. Seed reads the legacy v2 blob (which still has context-files).
    seedContextFilesPanelFromLegacy();

    // The new store must carry the user's saved values.
    const state = useContextFilesPanelStore.getState();
    expect(state.width).toBe(300);
    expect(state.collapsed).toBe(true);

    // 2. Simulate workbench v2→v3 migration (which happens after seed).
    //    Prove the migration drops context-files — correct only because the
    //    seed already harvested the value.
    const v2Raw = store.get("meridian:workbench-surface-layout");
    expect(v2Raw).toBeDefined();
    if (!v2Raw) throw new Error("missing legacy workbench prefs");
    const v2Parsed = JSON.parse(v2Raw);
    const migrated = migrateSurfacePrefsState(v2Parsed.state, v2Parsed.version);
    expect(migrated.prefs).not.toHaveProperty("context-files");
  });

  it("LOSES context-files prefs when workbench migrates first (wrong order — guards the bug)", () => {
    const { store, ls } = createMockLocalStorage();
    vi.stubGlobal("localStorage", ls);

    // Pre-upgrade state: v2 workbench blob with saved files-panel prefs.
    store.set(
      "meridian:workbench-surface-layout",
      JSON.stringify(makeV2Blob({ width: 300, collapsed: true })),
    );

    // WRONG order: simulate workbench v2→v3 migration happening first.
    // The migration rewrites the blob without context-files (just as zustand
    // persist does when the workbench store rehydrates before the seed).
    const v2Raw = store.get("meridian:workbench-surface-layout");
    expect(v2Raw).toBeDefined();
    if (!v2Raw) throw new Error("missing legacy workbench prefs");
    const v2Parsed = JSON.parse(v2Raw);
    const migrated = migrateSurfacePrefsState(v2Parsed.state, v2Parsed.version);
    // Write the migrated v3 blob back — this is what zustand persist does
    // after a version-mismatch rehydrate.
    store.set(
      "meridian:workbench-surface-layout",
      JSON.stringify({
        state: { prefs: migrated.prefs, slotPrefs: migrated.slotPrefs },
        version: 3,
      }),
    );

    // Now seed — reads the already-migrated blob, finds no context-files.
    seedContextFilesPanelFromLegacy();

    const state = useContextFilesPanelStore.getState();
    expect(state.width).toBe(220); // factory default — user's value lost
    expect(state.collapsed).toBe(false); // factory default — user's value lost
  });
});

describe("seedContextFilesPanelFromLegacy", () => {
  beforeEach(() => {
    resetContextFilesStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetContextFilesStore();
  });

  it("seeds from legacy when the new key is absent", () => {
    const { store, ls } = createMockLocalStorage();
    vi.stubGlobal("localStorage", ls);

    store.set(
      "meridian:workbench-surface-layout",
      JSON.stringify(makeV2Blob({ width: 248, collapsed: true })),
    );
    // No meridian:context-files-panel key.

    seedContextFilesPanelFromLegacy();

    const state = useContextFilesPanelStore.getState();
    expect(state.width).toBe(248);
    expect(state.collapsed).toBe(true);
  });

  it("is idempotent — no-op when the new key already exists", () => {
    const { store, ls } = createMockLocalStorage();
    vi.stubGlobal("localStorage", ls);

    // Pre-populate the new key to simulate a prior migration.
    store.set(
      "meridian:context-files-panel",
      JSON.stringify({ state: { width: 250, collapsed: false }, version: 0 }),
    );
    // Set a different legacy value.
    store.set(
      "meridian:workbench-surface-layout",
      JSON.stringify(makeV2Blob({ width: 300, collapsed: true })),
    );

    // Seed — should be a no-op because the gate sees the key exists.
    seedContextFilesPanelFromLegacy();

    const state = useContextFilesPanelStore.getState();
    // Keeps defaults (220), NOT overwritten by legacy (300).
    // The legacy value is NOT applied because the idempotent gate
    // localStorage.getItem("meridian:context-files-panel") !== null returns.
    expect(state.width).toBe(220);
    expect(state.collapsed).toBe(false);
  });

  it("no-ops without throwing when the legacy workbench key is absent", () => {
    const { ls } = createMockLocalStorage();
    vi.stubGlobal("localStorage", ls);

    // Neither key present.
    expect(() => seedContextFilesPanelFromLegacy()).not.toThrow();

    const state = useContextFilesPanelStore.getState();
    expect(state.width).toBe(220); // factory defaults
    expect(state.collapsed).toBe(false);
  });

  it("no-ops without throwing when the legacy JSON is corrupt", () => {
    const { store, ls } = createMockLocalStorage();
    vi.stubGlobal("localStorage", ls);

    store.set("meridian:workbench-surface-layout", "not valid json{{{");

    expect(() => seedContextFilesPanelFromLegacy()).not.toThrow();

    const state = useContextFilesPanelStore.getState();
    expect(state.width).toBe(220); // factory defaults preserved
    expect(state.collapsed).toBe(false);
  });

  it("handles legacy blob with prefs but no context-files key", () => {
    const { store, ls } = createMockLocalStorage();
    vi.stubGlobal("localStorage", ls);

    // A v1-style blob that has prefs but no context-files entry.
    const v1Blob = {
      state: {
        prefs: {
          chat: { width: 380, collapsed: false },
          threads: { width: 280, collapsed: false },
        },
      },
      version: 1,
    };
    store.set("meridian:workbench-surface-layout", JSON.stringify(v1Blob));

    expect(() => seedContextFilesPanelFromLegacy()).not.toThrow();

    const state = useContextFilesPanelStore.getState();
    // No context-files in legacy → defaults unchanged.
    expect(state.width).toBe(220);
    expect(state.collapsed).toBe(false);
  });
});
