// @vitest-environment jsdom
/** Independent Work drafts of one document must not overwrite each other's overlay. */
import { afterEach, expect, it } from "vitest";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import { resolveWorkspaceRoute } from "@/features/project/context/context-route-workspace-owner";
import { resolveRouteDocumentOwner } from "@/features/project/context/route-document-owner";
import {
  editorTabsForWork,
  getContextTabs,
  isEditorTab,
  useContextTabsStore,
} from "./context-tabs-store";

it("keeps overlay identity per document, Work and draft", () => {
  const store = useContextTabsStore.getState();
  const tab = {
    kind: "tracked" as const,
    documentId: "same",
    scheme: "kb" as const,
    path: "/Hero",
    name: "Hero",
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
    draftOnly: true,
  };
  const first = store.openTab("overlay-test", {
    ...tab,
    reviewWorkId: "work-a",
    reviewItemKey: "draft-a",
  });
  const second = store.openTab("overlay-test", {
    ...tab,
    reviewWorkId: "work-b",
    reviewItemKey: "draft-b",
  });
  expect(first.kind).toBe("opened");
  expect(second.kind).toBe("opened");
  if (first.kind !== "opened" || second.kind !== "opened") throw new Error("not opened");
  expect(first.tab.tabInstanceId).not.toBe(second.tab.tabInstanceId);
  const reopened = store.openTab("overlay-test", {
    ...tab,
    reviewWorkId: "work-b",
    reviewItemKey: "draft-b",
  });
  expect(reopened).toMatchObject({
    kind: "opened",
    tab: { tabInstanceId: second.tab.tabInstanceId },
  });
  expect(
    getContextTabs("overlay-test").tabs.map((row) =>
      row.kind !== "new" ? row.reviewItemKey : null,
    ),
  ).toEqual(["draft-a", "draft-b"]);
  expect(
    getContextTabs("overlay-test").tabs.filter((row) => isEditorTab(row, "work-b")),
  ).toMatchObject([{ reviewItemKey: "draft-b" }]);
});

afterEach(() => useContextTabsStore.setState({ byProject: {}, _reviewOverlayByProject: {} }));

it.each(["discard", "close"])("%s removes only the addressed Work overlay", async (action) => {
  const project = "multi-work-removal";
  const store = useContextTabsStore.getState();
  const open = (work: string) => {
    const result = store.openTab(project, {
      kind: "tracked",
      documentId: "same",
      scheme: "kb",
      path: "/Hero",
      name: "Hero",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      draftOnly: true,
      reviewWorkId: work,
      reviewItemKey: `draft-${work}`,
      tabInstanceToken: `token-${work}`,
    });
    if (result.kind !== "opened") throw new Error("not opened");
    return result.tab;
  };
  const a = open("a");
  const b = open("b");
  const route = {
    readSearch: () => ({
      screen: "context" as const,
      scheme: "kb" as const,
      path: "/Hero",
      work: "b",
    }),
    updateSearch: () => {},
    transition: async (
      _project: string,
      _target: unknown,
      prepared: { isCurrent?: () => boolean; commit?: () => void },
    ) => {
      expect(prepared.isCurrent?.()).toBe(true);
      prepared.commit?.();
      return { kind: "applied" as const };
    },
  };
  const coordinator = new ContextRemovalCoordinator("test-account", { route });
  coordinator.registerRoutePort(project, route, "b");
  if (action === "discard") {
    expect(coordinator.discardDraft(project, "b", "draft-b").kind).not.toBe("noop");
  } else {
    await store.selectTab(project, "b", "same");
    await coordinator.writerClose(project, b);
  }
  expect(getContextTabs(project).tabs).toEqual([a]);
  coordinator.dispose();
});

it("activates, renames and promotes the exact overlay without hiding another Work", async () => {
  const project = "overlay-settlement";
  const store = useContextTabsStore.getState();
  const open = (work: string) => {
    const result = store.openTab(project, {
      kind: "tracked",
      documentId: "same",
      scheme: "kb",
      path: "/Hero",
      name: "Hero",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      draftOnly: true,
      reviewWorkId: work,
      reviewItemKey: `draft-${work}`,
      tabInstanceToken: `token-${work}`,
    });
    if (result.kind !== "opened" || result.tab.kind !== "tracked") throw new Error("not opened");
    return result.tab;
  };
  const a = open("a");
  const b = open("b");
  const later = store.openTab(project, {
    ...b,
    tabInstanceId: undefined,
    reviewItemKey: "later-b",
    tabInstanceToken: "later-token",
  });
  if (later.kind !== "opened") throw new Error("not opened");
  await store.selectTab(project, "b", "same", later.tab);
  expect(
    resolveWorkspaceRoute({
      tabs: getContextTabs(project).tabs,
      selectedDocumentId: "same",
      selectedTabInstanceId: getContextTabs(project).selectedTabInstanceIdByWork?.b,
      boundDocumentId: "same",
      locator: { scheme: "kb", path: "/Hero", workId: "b" },
    }),
  ).toMatchObject({ kind: "owner", tab: { reviewItemKey: "later-b" } });
  expect(
    resolveRouteDocumentOwner({
      workspaceTabs: getContextTabs(project).tabs,
      selectedTabInstanceId: later.tab.tabInstanceId,
      boundDocumentId: "same",
      catalog: null,
      locator: { scheme: "kb", path: "/Hero", workId: "b" },
    }),
  ).toMatchObject({ kind: "draft-only", tab: { reviewItemKey: "later-b" } });
  const removal = new ContextRemovalCoordinator("test-account");
  await removal.writerClose(project, later.tab);
  expect(await removal.writerClose(project, later.tab)).toEqual({ kind: "noop" });
  expect(getContextTabs(project).tabs).toEqual([a, b]);
  const enriched = store.openTab(
    project,
    { ...b, draftOnly: false, reviewWorkId: "unrelated" },
    undefined,
    "b",
  );
  expect(enriched).toMatchObject({
    kind: "opened",
    tab: { reviewWorkId: "b", reviewItemKey: "draft-b", tabInstanceToken: "token-b" },
  });
  expect(useContextTabsStore.getState().byProject[project]).toBeUndefined();
  await store.selectTab(project, "b", "same", b);
  await store.selectTab(project, "unrelated", "same");
  expect(getContextTabs(project).selectedTabIdByWork).toEqual({ b: "same" });
  expect(
    resolveWorkspaceRoute({
      tabs: getContextTabs(project).tabs,
      selectedDocumentId: "same",
      boundDocumentId: "same",
      locator: { scheme: "kb", path: "/Hero", workId: "b" },
    }),
  ).toMatchObject({ kind: "owner", tab: { tabInstanceId: b.tabInstanceId } });
  await store.updateTrackedTab(project, b, { name: "Renamed", path: "/Renamed" });
  expect(getContextTabs(project).tabs).toMatchObject([{ name: "Hero" }, { name: "Renamed" }]);
  expect(await removal.promoteAppliedDraft(project, b)).toBe(true);
  expect(getContextTabs(project).selectedTabIdByWork.b).toBe("same");
  expect(editorTabsForWork(getContextTabs(project).tabs, "a")).toEqual([a]);
  expect(editorTabsForWork(getContextTabs(project).tabs, "b")).toMatchObject([{ name: "Renamed" }]);
  expect(await removal.promoteAppliedDraft(project, b)).toBe(false);
  expect(await removal.promoteAppliedDraft(project, a)).toBe(true);
  expect(getContextTabs(project).tabs).toHaveLength(1);
  expect(editorTabsForWork(getContextTabs(project).tabs, "a")).toHaveLength(1);
  expect(editorTabsForWork(getContextTabs(project).tabs, "b")).toHaveLength(1);
  removal.dispose();
});
