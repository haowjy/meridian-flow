// @vitest-environment jsdom
/** Real mutation settlement, draft-only tabs, route coordination and unopened-list refresh. */

import { onlineManager } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { resetBranchCommandRecords } from "@/client/query/branch-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { type ContextTab, getContextTabs, isDraftOnly, useContextTabsStore } from "@/client/stores";
import * as account from "@/features/project/context/account-feature-context";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { contextTabFromFile } from "@/features/project/context/context-tab-from-file";
import { dockDocument, useDockDocumentStore } from "@/features/project/dock/dock-document-store";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import type { ProjectSearch } from "@/features/project/routing/project-route";
import {
  applied,
  change,
  createReviewScopeFixture,
  deferredReviewAnswer,
  draftA,
  itemApplied,
  listed,
  previewOf,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";
import { settleReact } from "@/test-support/react-dom-harness";

const draftTab = contextTabFromDraftGroup({
  workId: "work-a",
  documentId: "document-a",
  itemKey: "draft-a",
  contextLocation: { scheme: "manuscript", path: "/chapter.md" },
  isNew: true,
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
  { workId: "work-a" },
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
  { workId: "work-a" },
);

let fixture: ReturnType<typeof createReviewScopeFixture>;
let removal: ContextRemovalCoordinator;
let search: ProjectSearch;
let writes: number;
const draftB = { documentId: "document-b", itemKey: "draft-b" };
// document-a is draft-only (hidden until Apply), so its list row is new.
const listedA = { ...listed, isNew: true };
const listedB = { ...listed, ...draftB, documentName: "Chapter 13" };
const tabs = () => getContextTabs("project-a").tabs;
async function open(p: () => ScopeProbe) {
  await act(async () => p().presented.controller.enterInlineReview("document-a", "draft-a"));
  await settleReact(() => expect(p().header.view.status).toBe("ready"));
}
beforeEach(() => {
  vi.useFakeTimers();
  resetBranchCommandRecords();
  useDockDocumentStore.setState(useDockDocumentStore.getInitialState(), true);
  useContextTabsStore.setState({
    byProject: {},
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
  fixture.network.listWorkBranchDrafts.mockResolvedValue({ items: [listedA, listedB] });
  fixture.network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
    ...previewOf(...(id === "draft-a" ? ["1", "2"] : ["3"])),
    itemKey: id,
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

it("draft-only Discard keeps both containers until its own terminal success; refusal keeps them", async () => {
  useDockDocumentStore.setState({
    occupant: dockDocument("project-a", "chat", draftTab!, null),
  });
  const answer = deferredReviewAnswer<Awaited<ReturnType<typeof fixture.network.discardDraft>>>();
  fixture.network.discardDraft.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    await open(p);
    const before = tabs();
    const occupant = useDockDocumentStore.getState().occupant;
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().presented.controller.discard("document-a", "draft-a");
    });
    expect(tabs()).toEqual(before);
    expect(useDockDocumentStore.getState().occupant).toBe(occupant);
    expect(writes).toBe(0);
    await act(async () => {
      answer.reject(new HttpResponseError("refused", 500, null));
      await done;
    });
    expect(tabs()).toEqual(before);
    expect(useDockDocumentStore.getState().occupant).toBe(occupant);
    fixture.network.discardDraft.mockResolvedValue({
      status: "discarded",
      branchId: listed.branchId,
      itemKey: "draft-a",
      itemClosed: true,
    });
    await act(async () => {
      await p().presented.controller.discard("document-a", "draft-a");
    });
    expect(tabs()).toMatchObject([{ documentId: "document-b" }]);
    expect(useDockDocumentStore.getState().occupant).toBeNull();
    expect(writes).toBe(1);
  });
});

it("a draft-only tab becomes the live document's tab the moment the replica shows it (a join)", async () => {
  type Snapshot = { records: unknown[]; folders: unknown[]; catalogs: unknown[] };
  let emit: (snapshot: Snapshot) => void = () => {};
  const replica = {
    observeProjection: (_project: string, next: (snapshot: Snapshot) => void) => {
      emit = next;
      next({ records: [], folders: [], catalogs: [] });
      return () => {};
    },
  };
  vi.spyOn(account, "useOptionalAccountResourceReplica").mockReturnValue(replica as never);
  await fixture.render(async (p) => {
    await open(p);
    expect(tabs().some(isDraftOnly)).toBe(true);
    // New file joined the hidden document: visible live, the draft's row still new (no refetch yet).
    await act(async () =>
      emit({
        records: [
          {
            resource: {
              handle: "resource-a",
              identity: { documentId: "document-live" },
              aliases: { "document-a": {} },
              lifecycle: { kind: "live" },
            },
            intents: [{ projectId: "project-a", state: "pending" }],
          },
        ],
        folders: [],
        catalogs: [],
      }),
    );
    await settleReact(() => expect(tabs().some(isDraftOnly)).toBe(false));
    expect(
      tabs()
        .map((tab) => tab.documentId)
        .sort(),
    ).toEqual(["document-a", "document-b"]);
  });
});

it("a lost whole Apply keeps the draft-only tab and review, apart from a server refusal", async () => {
  fixture.network.applyDraft.mockRejectedValue(new TypeError("Failed to fetch"));
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      const done = p().presented.controller.apply("document-a", "draft-a");
      await vi.advanceTimersByTimeAsync(6000);
      expect(await done).toEqual({ kind: "apply-outcome-unknown" });
    });
    expect(p().header.commandError).toEqual({ code: "apply-unknown" });
    expect(isDraftOnly(tabs().find((tab) => tab.documentId === "document-a") as ContextTab)).toBe(
      true,
    );
    expect(p().presented.controller.inlineReview?.itemKey).toBe("draft-a");
    fixture.network.applyDraft.mockRejectedValue(new HttpResponseError("refused", 500, null));
    await act(async () => {
      await p().presented.controller.apply("document-a", "draft-a");
    });
    expect(p().header.commandError).toEqual({ code: "apply-server-error" });
    expect(isDraftOnly(tabs().find((tab) => tab.documentId === "document-a") as ContextTab)).toBe(
      true,
    );
  });
});

it.each([
  "both",
  "dock",
] as const)("confirmed Apply promotes %s despite lagging catalog", async (container) => {
  useDockDocumentStore.setState({
    occupant: dockDocument("project-a", "chat", draftTab as NonNullable<typeof draftTab>, null),
  });
  if (container === "dock") useContextTabsStore.setState({ byProject: {} });
  const claim = useDockDocumentStore.getState().claim();
  fixture.network.applyDraft.mockResolvedValue(itemApplied());
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      await p().presented.controller.apply("document-a", "draft-a");
    });
    expect(p().presented.controller.inlineReview).toBeNull();
    const live = tabs().find((tab) => tab.documentId === "document-a");
    if (container === "both") {
      expect(live).toBeDefined();
      expect(live).not.toHaveProperty("reviews");
    } else expect(tabs()).toEqual([]);
    expect(useDockDocumentStore.getState().occupant?.tab).not.toHaveProperty("reviews");
    expect(useDockDocumentStore.getState().isCurrent(claim)).toBe(true);
    if (container === "dock") {
      const answer = deferredReviewAnswer<Awaited<ReturnType<typeof fixture.network.applyDraft>>>();
      fixture.network.applyDraft.mockReturnValueOnce(answer.promise);
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = p().presented.controller.apply("document-a", "draft-a");
      });
      fixture.epoch.abort();
      removal.dispose();
      useDockDocumentStore.getState().rehydrate("account-b");
      const replacement = dockDocument(
        "project-a",
        "chat",
        {
          ...draftTab!,
          reviews: Object.fromEntries(
            Object.entries(draftTab!.reviews ?? {}).map(([workId, entry]) => [
              workId,
              { ...entry, tabInstanceToken: "new-account-instance" },
            ]),
          ),
        },
        null,
      );
      useDockDocumentStore.getState().commit(useDockDocumentStore.getState().claim(), replacement);
      const revision = useDockDocumentStore.getState().revision;
      await act(async () => {
        answer.resolve(itemApplied());
        await pending;
      });
      expect(useDockDocumentStore.getState().occupant).toBe(replacement);
      expect(useDockDocumentStore.getState().revision).toBe(revision);
    }
  });
});

it("bulk progress reaches the next draft at confirmation without waiting for navigation", async () => {
  const navigate = vi.fn(() => new Promise<never>(() => {}));
  fixture.network.applyBranchDrafts.mockResolvedValue({
    status: "completed",
    branchId: listed.branchId,
    items: [
      { itemKey: "draft-a", status: "applied", notes: [] },
      { itemKey: "draft-b", status: "applied", notes: [] },
    ],
  });
  await fixture.render(
    async (p) => {
      await open(p);
      await act(async () => {
        expect(await p().presented.controller.disposeDrafts("apply", [draftA, draftB])).toEqual([
          { kind: "applied" },
          { kind: "applied" },
        ]);
      });
      expect(navigate).toHaveBeenCalled();
      expect(fixture.network.applyBranchDrafts).toHaveBeenCalledTimes(1);
      expect(p().presented.controller.isDisposing).toBe(false);
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
  const draftC = { documentId: "document-c", itemKey: "draft-c" };
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
        { draft: draftA, target: { kind: "operations" as const, selection: change("2") } },
        { draft: draftB, target: { kind: "operations" as const, selection: change("3") } },
        { draft: draftC, target: { kind: "operations" as const, selection: change("3") } },
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
        itemKey: id,
      }));
      fixture.network.listWorkBranchDrafts.mockResolvedValue({
        items: [listedA, { ...listedB, updatedAt: stamp }],
      });
      await act(async () => {
        await p().queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workBranchDrafts("project-a", "work-a"),
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
    expect(p().presented.controller.inlineReview?.itemKey).toBe("draft-a");
  });
});
