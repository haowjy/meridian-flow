// @vitest-environment jsdom
/** Real mutation settlement, draft-only tabs, route coordination and unopened-list refresh. */

import { onlineManager } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { contextTabFromFile } from "@/features/project/context/context-tab-from-file";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import type { ProjectSearch } from "@/features/project/routing/project-route";
import {
  applied,
  change,
  createReviewScopeFixture,
  deferredReviewAnswer,
  draftA,
  listed,
  previewOf,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";
import { settleReact } from "@/test-support/react-dom-harness";

const draftTab = contextTabFromDraftGroup({
  workId: "work-a",
  documentId: "document-a",
  draftId: "draft-a",
  contextPath: "/chapter.md",
  isNewDocument: true,
});
if (!draftTab) throw new Error("Draft tab fixture must be editable");

const addressedTab = contextTabFromFile(
  "manuscript",
  {
    kind: "file",
    entryId: "entry-a",
    parentId: "manuscript-root",
    documentId: "document-a",
    name: "chapter.md",
    path: "/chapter.md",
    uri: "manuscript://@work-a/chapter.md",
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    resourceHandle: "resource-a",
    resourceState: "acknowledged",
  },
  "work-a",
);

const neighborTab = contextTabFromFile(
  "manuscript",
  {
    kind: "file",
    entryId: "entry-b",
    parentId: "manuscript-root",
    documentId: "document-b",
    name: "live-neighbor.md",
    path: "/live-neighbor.md",
    uri: "manuscript://@work-a/live-neighbor.md",
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  },
  "work-a",
);

let fixture: ReturnType<typeof createReviewScopeFixture>;
let removal: ContextRemovalCoordinator;
let search: ProjectSearch;
let writes: number;
const draftB = { documentId: "document-b", draftId: "draft-b" };
const listedB = { ...listed, ...draftB, documentName: "Chapter 13" };
const tabs = () => getContextTabs("project-a").tabs;
async function open(p: () => ScopeProbe) {
  await act(async () => p().editor.controller.enterInlineReview("document-a", "draft-a"));
  await settleReact(() => expect(p().header.view.status).toBe("ready"));
}
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  useContextTabsStore.setState({
    byProject: {},
    _reviewOverlayByProject: {},
    _workspaceHydrated: false,
  });
  useContextTabsStore.getState().openTab("project-a", draftTab);
  useContextTabsStore.getState().openTab("project-a", addressedTab);
  useContextTabsStore.getState().openTab("project-a", neighborTab);
  void useContextTabsStore.getState().selectTab("project-a", "work-a", "document-a");
  search = { screen: "context", work: "work-a", scheme: "manuscript", path: "/chapter.md" };
  writes = 0;
  const route = {
    readSearch: () => search,
    updateSearch: (_project: string, update: (value: ProjectSearch) => ProjectSearch) => {
      search = update(search);
      writes++;
    },
    transition: async () => ({ kind: "applied" as const }),
  };
  removal = new ContextRemovalCoordinator("account-a", { route });
  removal.registerRoutePort("project-a", route, "work-a");
  const revision = removal.beginRouteSelection("project-a", {
    scheme: "manuscript",
    path: "/chapter.md",
    workId: "work-a",
  });
  removal.bindRouteSelection("project-a", revision, { kind: "server", documentId: "document-a" });
  fixture = createReviewScopeFixture({ removal });
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
  fixture.network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
    ...previewOf(...(id === "draft-a" ? ["1", "2"] : ["3"])),
    draftId: id,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
  fixture.dispose();
  removal.dispose();
  vi.restoreAllMocks();
});

it.each([
  [false, false],
  [false, true],
  [true, false],
])("header refuses offline Discard without removal or navigation (browser=%s, manager=%s)", async (browser, manager) => {
  const navigate = vi.fn();
  await fixture.render(
    async (p) => {
      await open(p);
      const before = tabs();
      const routeBefore = search;
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(browser);
      onlineManager.setOnline(manager);
      await act(async () => p().header.discardDraft());
      expect(tabs()).toEqual(before);
      expect(search).toEqual(routeBefore);
      expect(writes).toBe(0);
      expect(navigate).not.toHaveBeenCalled();
      expect(fixture.network.discardDraft).not.toHaveBeenCalled();
      expect(p().header.commandError).toEqual({ code: "discard-offline" });
      await act(async () => {
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
        onlineManager.setOnline(true);
      });
      expect(fixture.network.discardDraft).not.toHaveBeenCalled();
      expect(tabs()).toEqual(before);
    },
    { onOpenDraft: navigate },
  );
});

it("draft-only Discard closes its tab and repairs the route immediately; refusal never resurrects it", async () => {
  const answer = deferredReviewAnswer<Awaited<ReturnType<typeof fixture.network.discardDraft>>>();
  fixture.network.discardDraft.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    await open(p);
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().editor.controller.discard("document-a", "draft-a");
    });
    expect(tabs()).toMatchObject([{ documentId: "document-b" }]);
    expect(search.path).toBe("/live-neighbor.md");
    expect(writes).toBe(1);
    await act(async () => {
      answer.reject(new HttpResponseError("refused", 500, null));
      await done;
    });
    expect(p().header.commandError).toEqual({ code: "discard-server-error" });
    expect(tabs()).toMatchObject([{ documentId: "document-b" }]);
    expect(writes).toBe(1);
    fixture.network.discardDraft.mockResolvedValue({
      status: "discarded",
      draftId: "draft-a",
      draftClosed: true,
    });
    await act(async () => {
      await p().editor.controller.discard("document-a", "draft-a");
    });
    expect(p().header.commandError).toBeNull();
    expect(writes).toBe(1);
  });
});

it("an optimistic route-coordination exception before dispatch releases the claim for a real retry", async () => {
  const close = vi.spyOn(removal, "discardDraft").mockImplementationOnce(() => {
    throw new Error("route repair failed");
  });
  fixture.network.applyDraft.mockResolvedValue({ status: "applied", draftId: "draft-a" });
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      await expect(p().editor.controller.discard("document-a", "draft-a")).rejects.toThrow(
        "route repair failed",
      );
    });
    expect(fixture.network.discardDraft).not.toHaveBeenCalled();
    expect(tabs().find((tab) => tab.documentId === "document-a")?.draftOnly).toBe(true);
    expect(p().header.locked).toBe(false);
    close.mockRestore();
    await act(async () => {
      expect(await p().editor.controller.apply("document-a", "draft-a")).toEqual({
        kind: "applied",
      });
    });
    expect(fixture.network.applyDraft).toHaveBeenCalledTimes(1);
  });
});

it("a lost whole Apply keeps the draft-only tab and review, apart from a server refusal", async () => {
  fixture.network.applyDraft.mockRejectedValue(new TypeError("Failed to fetch"));
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      expect(await p().editor.controller.apply("document-a", "draft-a")).toEqual({
        kind: "apply-outcome-unknown",
      });
    });
    expect(p().header.commandError).toEqual({ code: "apply-unknown" });
    expect(tabs().find((tab) => tab.documentId === "document-a")?.draftOnly).toBe(true);
    expect(p().editor.controller.inlineReview?.draftId).toBe("draft-a");
    fixture.network.applyDraft.mockRejectedValue(new HttpResponseError("refused", 500, null));
    await act(async () => {
      await p().editor.controller.apply("document-a", "draft-a");
    });
    expect(p().header.commandError).toEqual({ code: "apply-server-error" });
    expect(tabs().find((tab) => tab.documentId === "document-a")?.draftOnly).toBe(true);
  });
});

it("confirmed Apply promotes the draft-only tab and ends review despite lagging catalog", async () => {
  fixture.network.applyDraft.mockResolvedValue({ status: "applied", draftId: "draft-a" });
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      await p().editor.controller.apply("document-a", "draft-a");
    });
    expect(p().editor.controller.inlineReview).toBeNull();
    const live = tabs().find((tab) => tab.documentId === "document-a");
    expect(live).toBeDefined();
    expect(live).not.toHaveProperty("draftOnly");
    expect(useContextTabsStore.getState()._reviewOverlayByProject["project-a"]?.tabs).toEqual([]);
  });
});

it("bulk progress reaches the next draft at confirmation without waiting for navigation", async () => {
  const navigate = vi.fn(() => new Promise<never>(() => {}));
  fixture.network.applyDraft.mockImplementation(async (_p, _w, _d, request) => ({
    status: "applied",
    draftId: request.draftId,
  }));
  await fixture.render(
    async (p) => {
      await open(p);
      await act(async () => {
        expect(await p().editor.controller.disposeDrafts("apply", [draftA, draftB])).toEqual([
          { kind: "applied" },
          { kind: "applied" },
        ]);
      });
      expect(navigate).toHaveBeenCalled();
      expect(fixture.network.applyDraft.mock.calls.map((call) => call[2])).toEqual([
        "document-a",
        "document-b",
      ]);
      expect(p().editor.controller.isDisposing).toBe(false);
    },
    {
      host: (children) => (
        <ProjectNavigationProvider
          openContextRoute={navigate}
          isCurrentContextRoute={() => true}
          screen="context"
        >
          {children}
        </ProjectNavigationProvider>
      ),
    },
  );
});

it("a missing preview sends no selection and does not stop later files in the batch", async () => {
  const draftC = { documentId: "document-c", draftId: "draft-c" };
  fixture.network.applyDraftChanges.mockResolvedValue(applied(false));
  await fixture.render(async (p) => {
    const viewA = await p().mountDraftChanges({
      projectId: "project-a",
      workId: "work-a",
      ...draftA,
    });
    const viewC = await p().mountDraftChanges({
      projectId: "project-a",
      workId: "work-a",
      ...draftC,
    });
    await settleReact(() => expect([viewA().status, viewC().status]).toEqual(["ready", "ready"]));
    await act(async () => {
      const outcomes = await p().chatRunner.applyBatch([
        { draft: draftA, selection: change("2") },
        { draft: draftB, selection: change("3") },
        { draft: draftC, selection: change("3") },
      ]);
      expect(outcomes.map(({ outcome }) => outcome.kind)).toEqual([
        "change-settled",
        "change-refused",
        "change-settled",
      ]);
      expect(outcomes[1].outcome).toEqual({ kind: "change-refused", mode: "apply", code: "stale" });
    });
    expect(fixture.network.applyDraftChanges.mock.calls.map((call) => call[2])).toEqual([
      "document-a",
      "document-c",
    ]);
  });
});

it("an unopened list follows a remote write and disposition through updated list rows without joining review", async () => {
  await fixture.render(async (p) => {
    await open(p);
    const view = await p().mountDraftChanges({
      projectId: "project-a",
      workId: "work-a",
      ...draftB,
    });
    await settleReact(() => expect(view().status).toBe("ready"));
    expect(view().items.map(({ change }) => change.classId)).toEqual(["class-3"]);
    const listChanged = async (stamp: string, ...ids: string[]) => {
      fixture.network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
        ...previewOf(...(id === "draft-b" ? ids : ["1", "2"])),
        draftId: id,
      }));
      fixture.network.listWorkDrafts.mockResolvedValue({
        drafts: [listed, { ...listedB, updatedAt: stamp }],
      });
      await act(async () => {
        await p().queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
        });
      });
    };
    await listChanged("2026-10-08T00:00:01.000Z", "3", "4");
    await settleReact(() =>
      expect(view().items.map(({ change }) => change.classId)).toEqual(["class-3", "class-4"]),
    );
    await listChanged("2026-10-08T00:00:02.000Z", "4");
    await settleReact(() =>
      expect(view().items.map(({ change }) => change.classId)).toEqual(["class-4"]),
    );
    expect(p().editor.controller.inlineReview?.draftId).toBe("draft-a");
  });
});
