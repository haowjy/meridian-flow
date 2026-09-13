// @vitest-environment jsdom
/** Real workspace commands commit before browser-local restore writes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  commitPlannedContextRemoval,
  rehydrateContextDesks,
  useContextTabsStore,
} from "./context-tabs-store";
import { EDITOR_WORKSPACE_STORAGE_KEY, parseEditorWorkspace } from "./editor-workspace-state";

const local = {
  kind: "new" as const,
  tabInstanceId: "member-a",
  documentId: "A",
  name: "Untitled",
  lineageHandle: "lineage-a",
  identityRevision: 1,
};
beforeEach(() => {
  sessionStorage.clear();
  useContextTabsStore.setState({
    byProject: {},
    _reviewOverlayByProject: {},
    _deskHydrated: false,
    _layoutPersistenceError: null,
  });
});
afterEach(() => vi.restoreAllMocks());

it("restores selected and explicitly empty layouts without touching shared localStorage", async () => {
  await rehydrateContextDesks("account");
  const store = useContextTabsStore.getState();
  await store.openTab("project", local);
  await store.selectTab("project", "", "A");
  const sharedWrite = vi.spyOn(Storage.prototype, "setItem");
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
  await rehydrateContextDesks("account");
  expect(useContextTabsStore.getState().byProject.project?.selectedTabIdByWork).toEqual({
    "": "A",
  });
  commitPlannedContextRemoval("project", {
    documentIds: ["A"],
    deskSelection: { workId: "", documentId: null },
  });
  expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([]);
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
  await rehydrateContextDesks("account");
  expect(useContextTabsStore.getState().byProject.project).toEqual({
    tabs: [],
    selectedTabIdByWork: {},
  });
  expect(sharedWrite.mock.contexts.every((storage) => storage === sessionStorage)).toBe(true);
});

it("ignores external layout storage events and same-account rehydration", async () => {
  await rehydrateContextDesks("account");
  await useContextTabsStore.getState().openTab("project", local);
  const before = useContextTabsStore.getState().byProject;
  const external = JSON.stringify({ version: 1, accountId: "account", projects: {} });
  window.dispatchEvent(
    new StorageEvent("storage", { key: "meridian:context-desk", newValue: external }),
  );
  window.dispatchEvent(
    new StorageEvent("storage", { key: EDITOR_WORKSPACE_STORAGE_KEY, newValue: external }),
  );
  await rehydrateContextDesks("account");
  expect(useContextTabsStore.getState().byProject).toBe(before);
});

it("keeps New and Close coherent when snapshot persistence fails", async () => {
  await rehydrateContextDesks("account");
  const writes = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await useContextTabsStore.getState().openTab("project", local);
  await useContextTabsStore.getState().selectTab("project", "", "A");
  expect(useContextTabsStore.getState().byProject.project?.tabs).toHaveLength(1);
  commitPlannedContextRemoval("project", {
    documentIds: ["A"],
    deskSelection: { workId: "", documentId: null },
  });
  expect(useContextTabsStore.getState().byProject.project).toEqual({
    tabs: [],
    selectedTabIdByWork: {},
  });
  expect(useContextTabsStore.getState()._layoutPersistenceError).toEqual(new Error("quota"));
  writes.mockRestore();
  await useContextTabsStore.getState().openTab("project", local);
  expect(useContextTabsStore.getState()._layoutPersistenceError).toBeNull();
  expect(
    parseEditorWorkspace(sessionStorage.getItem(EDITOR_WORKSPACE_STORAGE_KEY))?.projects.project
      ?.tabs,
  ).toHaveLength(1);
});

it("does not display another account's layout", async () => {
  await rehydrateContextDesks("account-a");
  await useContextTabsStore.getState().openTab("project", local);
  await rehydrateContextDesks("account-b");
  expect(useContextTabsStore.getState().byProject).toEqual({});
});
