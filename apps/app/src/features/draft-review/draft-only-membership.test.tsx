// @vitest-environment jsdom
/** Branch-only entries of several Works on one document: Discard and promotion decide once, by the container's own address. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getContextTabs,
  isDraftOnly,
  ThreadStoreProvider,
  useContextTabsStore,
} from "@/client/stores";
import * as account from "@/features/project/context/account-feature-context";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { dockDocument, useDockDocumentStore } from "@/features/project/dock/dock-document-store";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { PresentedDocumentContext } from "@/features/project/presented-document";
import { createReviewScopeFixture, listed } from "@/test-support/draft-review-scope";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import { DraftOnlySettlement } from "./DraftOnlySettlement";
import { type DraftOnlyContainer, useDraftOnlyLifecycle } from "./draft-only-lifecycle";

const location = { scheme: "manuscript" as const, path: "/chapter.md" };
const entry = (workId: string, itemKey: string) =>
  contextTabFromDraftGroup({
    workId,
    documentId: "document-a",
    itemKey,
    contextLocation: location,
    isNew: true,
  });
const refOf = (workId: string, itemKey: string) => ({
  projectId: "project-a",
  workId,
  itemKey,
  documentId: "document-a",
});
let fixture: ReturnType<typeof createReviewScopeFixture>;
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  fixture = createReviewScopeFixture();
  useDockDocumentStore.setState(useDockDocumentStore.getInitialState(), true);
  useContextTabsStore.setState({ byProject: {}, _workspaceHydrated: false });
  for (const tab of [entry("work-a", "draft-a"), entry("work-b", "draft-b")])
    if (tab) useContextTabsStore.getState().openTab("project-a", tab);
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  fixture.dispose();
});

it("Discard in one Work leaves the dock showing another Work's review, listed once", async () => {
  const shared = getContextTabs("project-a").tabs[0];
  if (!shared) throw new Error("Missing shared draft tab");
  useDockDocumentStore.setState({
    occupant: dockDocument("project-a", "chat", shared, { workId: "work-b", itemKey: "draft-b" }),
  });
  let lifecycle!: DraftOnlyContainer;
  function Capture() {
    lifecycle = useDraftOnlyLifecycle("project-a");
    return null;
  }
  await withReactRoot(<Capture />, async () => {
    const dockEntries = () =>
      lifecycle.presentations("project-a").filter((draft) => draft.container === "dock");
    expect(dockEntries().map((draft) => draft.workId)).toEqual(["work-b"]);

    lifecycle.remove(refOf("work-a", "draft-a"));
    expect(useDockDocumentStore.getState().occupant?.review).toMatchObject({ workId: "work-b" });

    // Becoming live is document-wide and keeps the review the dock chose.
    await lifecycle.promote(refOf("work-a", "draft-a"));
    const occupant = useDockDocumentStore.getState().occupant;
    expect(occupant && isDraftOnly(occupant.tab)).toBe(false);
    expect(occupant?.review).toMatchObject({ workId: "work-b", itemKey: "draft-b" });
  });
});

it("a join seen first by one Work keeps the review another Work has on screen", async () => {
  const openReview = vi.fn(async () => undefined);
  spies.push(
    vi.spyOn(handoff, "useOptionalOpenEditorReview").mockReturnValue(openReview),
    vi.spyOn(account, "useOptionalAccountResourceReplica").mockReturnValue({
      observeProjection: (_project: string, next: (snapshot: unknown) => void) => {
        next({ records: [], folders: [], catalogs: [] });
        return () => undefined;
      },
    } as never),
    vi.spyOn(account, "useObservedResourceProjection").mockReturnValue({
      records: [{ resource: { handle: "h", identity: { documentId: "document-a" }, aliases: {} } }],
      folders: [],
      snapshot: null,
      error: null,
    } as never),
  );
  // Work A's observer is ready first: it must not decide what Work B has on screen.
  fixture.network.listWorkBranchDrafts.mockImplementation(async (_project, workId) => {
    if (workId === "work-b") await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      items: [
        { ...listed, isNew: true, contextLocation: location },
        { ...listed, isNew: true, itemKey: "draft-b", contextLocation: location },
      ],
    };
  });
  const presented = {
    container: "editor" as const,
    documentId: "document-a",
    scheme: "manuscript" as const,
    path: "/chapter.md",
    // The route dropped `item` (New file moved the writer on): Work B's own entry is what to restore.
    review: null,
    draftOnly: true,
  };
  await withReactRoot(
    <QueryClientProvider client={new QueryClient()}>
      <ThreadStoreProvider now={0}>
        <PresentedDocumentContext.Provider value={presented}>
          <DraftOnlySettlement projectId="project-a" editorWorkId="work-b" />
        </PresentedDocumentContext.Provider>
      </ThreadStoreProvider>
    </QueryClientProvider>,
    async () => {
      await settleReact(() => expect(openReview).toHaveBeenCalled());
      expect(openReview).toHaveBeenCalledTimes(1);
      expect(openReview).toHaveBeenCalledWith(
        expect.objectContaining({ workId: "work-b", itemKey: "draft-b" }),
      );
      expect(getContextTabs("project-a").tabs.some(isDraftOnly)).toBe(false);
    },
  );
});
