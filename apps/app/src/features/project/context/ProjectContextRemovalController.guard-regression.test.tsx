/** Production-controller guard regression over the browser working-set adapter. */

import { act, useLayoutEffect, useState } from "react";
import { expect, it } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import {
  configureWorkingSetSync,
  readRecentRoutes,
  reconcileContextRoutes,
} from "@/client/working-set/driver";
import { DeviceWorkingSetStore, WORKING_SET_STORAGE_KEY } from "@/client/working-set/store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ProjectSearch } from "../routing/project-route";
import {
  ContextRemovalAccountProvider,
  useContextRemovalCoordinator,
} from "./ContextRemovalAccountProvider";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectContextRemovalController } from "./ProjectContextRemovalController";

it("keeps a terminally guarded production entry absent until replacement identity binds", async () => {
  const projectId = "guarded-entry-project";
  const accountId = "guarded-entry-account";
  const workId = "work-1";
  const locatorA = { scheme: "manuscript" as const, path: "/a.md", workId };
  const locatorC = { scheme: "manuscript" as const, path: "/c.md", workId };
  useContextTabsStore.setState({
    byProject: {
      [projectId]: {
        tabs: [
          {
            kind: "tracked",
            documentId: "a",
            scheme: "manuscript",
            path: "/a.md",
            name: "a.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
          {
            kind: "tracked",
            documentId: "c",
            scheme: "manuscript",
            path: "/c.md",
            name: "c.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        activeTabId: "a",
      },
    },
    _deskHydrated: true,
  });

  let coordinator: ContextRemovalCoordinator | null = null;
  let setEntry: ((entry: { screen: "home" | "context"; path: string | null }) => void) | null =
    null;
  let search: ProjectSearch = { screen: "home" };
  const productionRoute = {
    readSearch: () => search,
    updateSearch: (_projectId: string, update: (current: ProjectSearch) => ProjectSearch) => {
      search = update(search);
    },
  };
  function SeedWorkingSet() {
    useLayoutEffect(() => {
      window.localStorage.removeItem(WORKING_SET_STORAGE_KEY);
      configureWorkingSetSync(accountId, false);
      reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: [],
        promote: { scheme: "manuscript", path: "/c.md" },
        clearAll: false,
      });
      reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: [],
        promote: { scheme: "manuscript", path: "/a.md" },
        clearAll: false,
      });
    }, []);
    return null;
  }
  function Capture() {
    coordinator = useContextRemovalCoordinator();
    return null;
  }
  function Harness() {
    const [entry, updateEntry] = useState<{
      screen: "home" | "context";
      path: string | null;
    }>({ screen: "home", path: null });
    setEntry = updateEntry;
    return (
      <ContextRemovalAccountProvider accountId={accountId}>
        <SeedWorkingSet />
        <Capture />
        <ProjectContextRemovalController
          projectId={projectId}
          activeScreen={entry.screen}
          activeContextScheme={entry.path ? "manuscript" : null}
          activeContextPath={entry.path}
          editorWorkId={workId}
          route={productionRoute}
        />
      </ContextRemovalAccountProvider>
    );
  }

  function admitExact(locator: typeof locatorA, documentId: string) {
    if (!coordinator) throw new Error("expected coordinator");
    const capture = coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator,
      documentId,
    });
    coordinator.acceptAcknowledgedDelete({
      ...capture,
      cause: "acknowledged-delete",
      confirmed: { status: "deleted", deletedDocumentIds: [documentId] },
    });
  }

  function expectAAbsent() {
    if (!coordinator) throw new Error("expected coordinator");
    expect(coordinator.getProjectSnapshot(projectId).rememberedRoute?.path).not.toBe("/a.md");
    expect(readRecentRoutes(projectId)).not.toContainEqual(
      expect.objectContaining({ path: "/a.md" }),
    );
    const raw = window.localStorage.getItem(WORKING_SET_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("/a.md");
    const reconstructed = new DeviceWorkingSetStore(window.localStorage);
    reconstructed.setUser(accountId);
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes ?? []).not.toContainEqual(
      expect.objectContaining({ path: "/a.md" }),
    );
  }

  await withReactRoot(<Harness />, async () => {
    if (!coordinator) throw new Error("expected coordinator");
    expect(readRecentRoutes(projectId)).toEqual([
      { scheme: "manuscript", path: "/a.md" },
      { scheme: "manuscript", path: "/c.md" },
    ]);
    expect(window.localStorage.getItem(WORKING_SET_STORAGE_KEY)).toContain("/a.md");
    let revision = coordinator.beginRouteSelection(projectId, locatorA);
    coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId: "a" });
    admitExact(locatorA, "a");

    revision = coordinator.beginRouteSelection(projectId, locatorC);
    admitExact(locatorC, "c");
    expect(coordinator.getProjectSnapshot(projectId).selection).toMatchObject({
      status: "pending",
      revision,
      locator: locatorC,
      obligations: [expect.any(Object)],
    });

    search = { screen: "context", work: workId, scheme: "manuscript", path: "/a.md" };
    await act(async () => setEntry?.({ screen: "context", path: "/a.md" }));

    const guarded = coordinator.getProjectSnapshot(projectId);
    expect(guarded).toMatchObject({
      selection: { status: "pending", locator: locatorA },
      rememberedRoute: null,
      removalFence: { removedDocumentIds: ["c"] },
    });
    expect(search).toEqual({
      screen: "context",
      work: workId,
      scheme: "manuscript",
      path: "/a.md",
    });
    expectAAbsent();

    const guardedRevision = guarded.selection.revision;
    coordinator.confirmRouteUnbound(projectId, guardedRevision);
    expectAAbsent();

    const replacementRevision = coordinator.beginRouteSelection(projectId, locatorA);
    coordinator.bindRouteSelection(projectId, replacementRevision, {
      kind: "server",
      documentId: "replacement-a",
    });
    expect(coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: {
        status: "bound",
        locator: locatorA,
        identity: { documentId: "replacement-a" },
      },
      rememberedRoute: locatorA,
    });
    expect(readRecentRoutes(projectId)).toContainEqual({
      scheme: "manuscript",
      path: "/a.md",
    });
    expect(window.localStorage.getItem(WORKING_SET_STORAGE_KEY)).toContain("/a.md");
    const reconstructed = new DeviceWorkingSetStore(window.localStorage);
    reconstructed.setUser(accountId);
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes).toContainEqual({
      scheme: "manuscript",
      path: "/a.md",
    });
  });
});
