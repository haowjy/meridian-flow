// @vitest-environment jsdom
/** Hydrated production-store regression for durable draft Apply settlement. */

import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { act, createElement, Fragment, useEffect } from "react";
import { beforeEach, expect, it } from "vitest";
import type { ReconcileContextRoutesInput } from "@/client/working-set";
import { reconcileSnapshotContextRoutes } from "@/client/working-set/store";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import {
  EditorReviewHandoffProvider,
  useOpenEditorReview,
} from "@/features/project/dock/editor-review-handoff";
import type { ProjectSearch } from "@/features/project/routing/project-route";
import { acceptContextTransition } from "@/test-support/context-removal-route";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  commitDraftApplyMetadata,
  getContextTabs,
  rehydrateEditorWorkspace,
  useContextTabs,
  useContextTabsStore,
} from "./context-tabs-store";
import { EDITOR_WORKSPACE_STORAGE_KEY, parseEditorWorkspace } from "./editor-workspace-state";

beforeEach(() => {
  sessionStorage.clear();
  useContextTabsStore.setState({
    byProject: {},
    _reviewOverlayByProject: {},
    _workspaceHydrated: false,
  });
  routeSlice = null;
});

it("lets settled Discard own effects before a later Close", async () => {
  const accountId = `discard-wins-${crypto.randomUUID()}`;
  const projectId = "discard-wins-project";
  await rehydrateEditorWorkspace(accountId);
  await useContextTabsStore.getState().openTab(projectId, {
    kind: "tracked",
    tabInstanceId: "review-tab",
    documentId: "document-1",
    scheme: "manuscript",
    path: "/chapter.md",
    name: "chapter.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    draftOnly: true,
    reviewWorkId: "work-a",
    reviewDraftId: "draft-a",
    tabInstanceToken: "token-a",
  });
  let reconciliations = 0;
  const coordinator = new ContextRemovalCoordinator(accountId, {
    workingSet: {
      readRecentRoutes: () => [],
      replaceRecentRoutes: (_id, routes) => [...routes],
      reconcileContextRoutes: () => {
        reconciliations += 1;
        return [];
      },
    },
  });
  await expect(coordinator.discardDraft(projectId, "work-a", "document-1")).resolves.not.toEqual({
    kind: "noop",
  });
  expect(coordinator.writerClose(projectId, "document-1")).toEqual({ kind: "noop" });
  expect(reconciliations).toBe(1);
});

let launchReview: ReturnType<typeof useOpenEditorReview> | null = null;
let routeSlice: ReturnType<typeof useContextTabs> | null = null;

function ReviewCommandCapture() {
  const command = useOpenEditorReview();
  useEffect(() => {
    launchReview = command;
    return () => {
      launchReview = null;
    };
  }, [command]);
  return null;
}

function ReviewRouteConsumer({ projectId }: { projectId: string }) {
  // Red at 23f9a19e: an overlay made this production hook warn that getSnapshot
  // was uncached, then terminate the route with Maximum update depth exceeded.
  routeSlice = useContextTabs(projectId);
  return null;
}

it("durably installs a hydrated draft Apply before acknowledging settlement", async () => {
  const accountId = `draft-apply-${crypto.randomUUID()}`;
  await rehydrateEditorWorkspace(accountId);
  await useContextTabsStore.getState().openTab("project-1", {
    kind: "tracked",
    tabInstanceId: "draft-tab",
    documentId: "document-1",
    scheme: "manuscript",
    path: "/chapter.md",
    name: "chapter.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    draftOnly: true,
    reviewWorkId: "work-a",
    reviewDraftId: "draft-a",
    tabInstanceToken: "token-a",
  });

  await expect(
    commitDraftApplyMetadata("project-1", {
      documentId: "document-1",
      tabInstanceId: "draft-tab",
      reviewWorkId: "work-a",
      reviewDraftId: "draft-a",
      tabInstanceToken: "token-a",
    }),
  ).resolves.toEqual({ kind: "settled" });

  expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toMatchObject([
    { documentId: "document-1", tabInstanceId: "draft-tab" },
  ]);
  expect(useContextTabsStore.getState().byProject["project-1"]?.tabs[0]).not.toHaveProperty(
    "draftOnly",
  );
  expect(
    parseEditorWorkspace(sessionStorage.getItem(EDITOR_WORKSPACE_STORAGE_KEY))?.projects[
      "project-1"
    ],
  ).toMatchObject({ tabs: [{ documentId: "document-1", tabInstanceId: "draft-tab" }] });
});

it("explicitly closes a review overlay without issuing a durable workspace removal", async () => {
  const accountId = `draft-close-${crypto.randomUUID()}`;
  const projectId = "project-close";
  await rehydrateEditorWorkspace(accountId);
  await useContextTabsStore.getState().openTab(projectId, {
    kind: "tracked",
    tabInstanceId: "close-tab",
    documentId: "close-document",
    scheme: "manuscript",
    path: "/close.md",
    name: "close.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    draftOnly: true,
    reviewWorkId: "close-work",
    reviewDraftId: "close-draft",
    tabInstanceToken: "close-token",
  });
  await useContextTabsStore.getState().selectTab(projectId, "close-work", "close-document");

  const coordinator = new ContextRemovalCoordinator(accountId);
  expect(coordinator.writerClose(projectId, "close-document")).not.toEqual({ kind: "noop" });
  expect(getContextTabs(projectId).tabs).toEqual([]);
  expect(useContextTabsStore.getState().byProject[projectId]).toBeUndefined();
  expect(
    parseEditorWorkspace(sessionStorage.getItem(EDITOR_WORKSPACE_STORAGE_KEY))?.projects[projectId],
  ).toBe(undefined);
  coordinator.dispose();
});

it.each([
  "different",
  "retained",
] as const)("keeps same-document durable continuity after Close with a %s tab instance", async (instanceCase) => {
  const accountId = `same-document-${instanceCase}-${crypto.randomUUID()}`;
  const projectId = `project-${instanceCase}`;
  const workId = "work-a";
  await rehydrateEditorWorkspace(accountId);
  const review = {
    kind: "tracked" as const,
    tabInstanceId: "review-tab",
    documentId: "document-1",
    scheme: "manuscript" as const,
    path: "/chapter.md",
    name: "chapter.md",
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
    draftOnly: true,
    reviewWorkId: workId,
    reviewDraftId: "draft-a",
    tabInstanceToken: "token-a",
  };
  await useContextTabsStore.getState().openTab(projectId, review);
  await useContextTabsStore.getState().selectTab(projectId, workId, review.documentId);
  const durable = {
    ...review,
    tabInstanceId: instanceCase === "retained" ? review.tabInstanceId : "durable-tab",
    draftOnly: undefined,
    reviewWorkId: undefined,
    reviewDraftId: undefined,
    tabInstanceToken: undefined,
  };
  await useContextTabsStore.getState().openTab(projectId, durable);

  let search: ProjectSearch = {
    screen: "context",
    work: workId,
    scheme: "manuscript",
    path: "/chapter.md",
  };
  let routes: WorkingSetRoute[] = [
    { documentId: review.documentId, scheme: "manuscript", path: "/chapter.md" },
  ];
  const route = {
    transition: acceptContextTransition,
    readSearch: () => search,
    updateSearch: (_id: string, update: (latest: ProjectSearch) => ProjectSearch) => {
      search = update(search);
    },
  };
  const coordinator = new ContextRemovalCoordinator(accountId, {
    route,
    workingSet: {
      readRecentRoutes: () => routes,
      replaceRecentRoutes: (_id, next) => {
        routes = [...next];
        return routes;
      },
      reconcileContextRoutes: (_id, input: ReconcileContextRoutesInput) => {
        routes = reconcileSnapshotContextRoutes(
          { recentRoutes: routes, lastThreadId: null },
          input,
        ).recentRoutes;
        return routes;
      },
    },
  });
  coordinator.registerRoutePort(projectId, route, workId);
  const revision = coordinator.beginRouteSelection(projectId, {
    scheme: "manuscript",
    path: "/chapter.md",
    workId,
  });
  coordinator.bindRouteSelection(projectId, revision, {
    kind: "server",
    documentId: review.documentId,
  });

  expect(coordinator.writerClose(projectId, review.documentId)).toMatchObject({
    kind: "inactive-removal",
  });
  expect(getContextTabs(projectId)).toMatchObject({
    tabs: [{ tabInstanceId: durable.tabInstanceId, documentId: review.documentId }],
    selectedTabIdByWork: { [workId]: review.documentId },
  });
  expect(search).toEqual({
    screen: "context",
    work: workId,
    scheme: "manuscript",
    path: "/chapter.md",
  });
  expect(routes).toEqual([
    { documentId: review.documentId, scheme: "manuscript", path: "/chapter.md" },
  ]);
  expect(coordinator.getProjectSnapshot(projectId).admitted).toEqual({
    scheme: "manuscript",
    path: "/chapter.md",
    workId,
  });
});

it("keeps the provider-mounted review overlay through route selection and Apply", async () => {
  // Red at eb1e3cad: route selection erased the mounted draft, Apply returned
  // false, and recovery acknowledged the missing obligation as already-absent.
  const accountId = `draft-route-${crypto.randomUUID()}`;
  const projectId = "project-route";
  const documentId = "document-route";
  const draftId = "draft-route";
  await rehydrateEditorWorkspace(accountId);

  await withReactRoot(
    createElement(EditorReviewHandoffProvider, {
      projectId,
      openContextRoute: async (_target, options) => {
        if (options?.tab) useContextTabsStore.getState().openTab(projectId, options.tab);
        await useContextTabsStore.getState().selectTab(projectId, "work-route", documentId);
        return { kind: "applied" as const };
      },
      children: createElement(
        Fragment,
        null,
        createElement(ReviewCommandCapture),
        createElement(ReviewRouteConsumer, { projectId }),
      ),
    }),
    async () => {
      if (!launchReview) throw new Error("review command was not mounted");
      await act(async () => {
        await launchReview?.({
          workId: "work-route",
          documentId,
          draftId,
          contextPath: "/route.md",
          isNewDocument: true,
        });
      });

      const transient = getContextTabs(projectId);
      expect(routeSlice).toBe(transient);
      const overlayTab = transient.tabs[0];
      if (overlayTab?.kind !== "tracked" || !overlayTab.tabInstanceToken)
        throw new Error("review overlay was not mounted");
      expect(transient.selectedTabIdByWork).toEqual({ "work-route": documentId });
      expect(useContextTabsStore.getState().byProject[projectId]).toBeUndefined();
      expect(
        parseEditorWorkspace(sessionStorage.getItem(EDITOR_WORKSPACE_STORAGE_KEY))?.projects[
          projectId
        ],
      ).toBeUndefined();

      const coordinator = new ContextRemovalCoordinator(accountId);
      const recovery = {
        identity: { accountId, projectId, workId: "work-route", documentId, draftId },
        entryVersion: 1,
        dispositionToken: 1,
        disposition: "live-ready" as const,
        draftTab: {
          kind: "draft-only" as const,
          reviewWorkId: "work-route",
          reviewDraftId: draftId,
          tabInstanceToken: overlayTab.tabInstanceToken,
        },
      };
      await expect(coordinator.settleDraftRecovery(recovery)).resolves.toMatchObject({
        kind: "metadata-resolved",
      });
      expect(useContextTabsStore.getState()._reviewOverlayByProject[projectId]).toEqual({
        tabs: [],
        selectedTabIdByWork: { "work-route": documentId },
      });
      expect(useContextTabsStore.getState().byProject[projectId]?.tabs[0]).not.toHaveProperty(
        "draftOnly",
      );

      await rehydrateEditorWorkspace(accountId);
      expect(getContextTabs(projectId).tabs).toMatchObject([{ documentId }]);
      expect(
        parseEditorWorkspace(sessionStorage.getItem(EDITOR_WORKSPACE_STORAGE_KEY))?.projects[
          projectId
        ],
      ).toEqual(useContextTabsStore.getState().byProject[projectId]);
      coordinator.dispose();
    },
  );
});
