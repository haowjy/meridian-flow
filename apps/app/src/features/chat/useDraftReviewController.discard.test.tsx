// @vitest-environment jsdom
/** Draft-only Discard projects disappearance immediately and restores it on refusal. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { contextTabFromFile } from "@/features/project/context/context-tab-from-file";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

let rejectDiscard: ((reason: unknown) => void) | null = null;
let navigationRevision = 0;
let currentAddress = "";
const removeDraftTab = vi.fn(() => {
  const tab = getContextTabs("project-a").tabs.find(
    (candidate) => candidate.documentId === "document-a",
  );
  if (
    tab?.kind !== "tracked" ||
    !tab.tabInstanceId ||
    !tab.reviewWorkId ||
    !tab.reviewDraftId ||
    !tab.tabInstanceToken
  )
    return;
  useContextTabsStore.getState().consumeReviewTab("project-a", {
    documentId: tab.documentId,
    tabInstanceId: tab.tabInstanceId,
    reviewWorkId: tab.reviewWorkId,
    reviewDraftId: tab.reviewDraftId,
    tabInstanceToken: tab.tabInstanceToken,
  });
  navigationRevision += 1;
  currentAddress = "/projects/project-a/@work-a/manuscript/live-neighbor.md";
  void useContextTabsStore.getState().selectTab("project-a", "work-a", "document-b");
  return { kind: "noop" as const };
});
const restoreDiscardedDraft = vi.fn();

vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: vi.fn(async () => ({
    status: "active",
    draftId: "draft-a",
    reviewRoomName: "review-room-a",
  })),
}));

vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useApplyDraft: () => ({ mutateAsync: vi.fn() }),
  useDiscardDraft: () => ({
    mutateAsync: () =>
      new Promise((_resolve, reject) => {
        rejectDiscard = reject;
      }),
  }),
}));

vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({
    discardDraft: removeDraftTab,
    restoreDiscardedDraft,
  }),
}));

vi.mock("@/features/project/draft-apply-recovery/DraftApplyRecoveryProvider", () => ({
  usePostApplyAccountId: () => "account-a",
}));

vi.mock("@/features/project/draft-apply-recovery/ProjectDraftApplyRecoveryExecutor", () => ({
  useProjectDraftApplyRecovery: () => ({
    awaitInitialOutcome: vi.fn(),
  }),
}));

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

let controller: DraftReviewController | null = null;

function CaptureController() {
  controller = useDraftReviewController("project-a", "work-a");
  return null;
}

function Providers({ children, open }: { children: ReactNode; open: OpenContextRoute }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ProjectNavigationProvider
        openContextRoute={open}
        captureNavigation={() => {
          const capturedRevision = navigationRevision;
          return () => capturedRevision === navigationRevision;
        }}
        captureCurrentNavigation={() => {
          const capturedRevision = navigationRevision;
          return () => capturedRevision === navigationRevision;
        }}
        screen="context"
      >
        {children}
      </ProjectNavigationProvider>
    </QueryClientProvider>
  );
}

describe("draft-only Discard", () => {
  beforeEach(() => {
    controller = null;
    rejectDiscard = null;
    navigationRevision = 0;
    currentAddress = "/projects/project-a/@work-a/manuscript/chapter.md";
    removeDraftTab.mockClear();
    restoreDiscardedDraft.mockClear();
    useContextTabsStore.setState({
      byProject: {},
      _reviewOverlayByProject: {},
      _workspaceHydrated: false,
    });
    useContextTabsStore.getState().openTab("project-a", draftTab);
    // The readable address owner resolves the same server document after the
    // review launcher installs its transient tab. It must not create a hidden
    // durable member underneath the review overlay.
    useContextTabsStore.getState().openTab("project-a", addressedTab);
    expect(getContextTabs("project-a").tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: "document-a",
          draftOnly: true,
          resourceHandle: "resource-a",
        }),
      ]),
    );
    useContextTabsStore.getState().openTab("project-a", neighborTab);
    void useContextTabsStore.getState().selectTab("project-a", "work-a", "document-a");
  });

  it("closes immediately, then restores the tab, review, and address when Discard fails", async () => {
    const open = vi.fn<OpenContextRoute>(async (_target, options) => {
      if (options?.tab) {
        useContextTabsStore.getState().openTab("project-a", options.tab);
        await useContextTabsStore
          .getState()
          .selectTab("project-a", "work-a", options.tab.documentId);
        currentAddress = "/projects/project-a/@work-a/manuscript/chapter.md";
      }
      return { kind: "applied" as const };
    });
    await withReactRoot(
      <Providers open={open}>
        <CaptureController />
      </Providers>,
      async () => {
        await act(async () => controller?.enterInlineReview("document-a", "draft-a"));
        expect(useContextTabsStore.getState().byProject["project-a"]?.tabs ?? []).toMatchObject([
          { documentId: "document-b" },
        ]);
        let disposition: Promise<unknown> | undefined;
        await act(async () => {
          disposition = controller?.discard("document-a", "draft-a");
        });

        expect(removeDraftTab).toHaveBeenCalledWith("project-a", "work-a", "document-a");
        expect(getContextTabs("project-a").tabs).toMatchObject([{ documentId: "document-b" }]);

        await act(async () => {
          rejectDiscard?.(new Error("offline"));
          await disposition;
        });

        expect(open).toHaveBeenCalledWith(
          expect.objectContaining({ documentId: "document-a", path: "/chapter.md" }),
          expect.objectContaining({
            replace: true,
            draftId: "draft-a",
            tab: expect.objectContaining(draftTab),
          }),
        );
        expect(restoreDiscardedDraft).toHaveBeenCalledWith(
          "project-a",
          "work-a",
          expect.objectContaining({ documentId: "document-a" }),
        );
        expect(getContextTabs("project-a").tabs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ documentId: "document-a", draftOnly: true }),
            expect.objectContaining({ documentId: "document-b" }),
          ]),
        );
        expect(getContextTabs("project-a").selectedTabIdByWork["work-a"]).toBe("document-a");
        expect(currentAddress).toBe("/projects/project-a/@work-a/manuscript/chapter.md");
        expect(controller?.inlineReview).toMatchObject({
          documentId: "document-a",
          draftId: "draft-a",
        });
        expect(controller?.inlineReviewMessage).toEqual({
          code: "discard-offline",
          tone: "error",
        });
      },
    );
  });

  it("restores in the background when the writer navigates after the optimistic close", async () => {
    const open = vi.fn<OpenContextRoute>();
    await withReactRoot(
      <Providers open={open}>
        <CaptureController />
      </Providers>,
      async () => {
        await act(async () => controller?.enterInlineReview("document-a", "draft-a"));
        let disposition: Promise<unknown> | undefined;
        await act(async () => {
          disposition = controller?.discard("document-a", "draft-a");
        });

        navigationRevision += 1;
        currentAddress = "/projects/project-a/@work-a/manuscript/writer-choice.md";

        await act(async () => {
          rejectDiscard?.(new Error("offline"));
          await disposition;
        });

        expect(open).not.toHaveBeenCalled();
        expect(getContextTabs("project-a").tabs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ documentId: "document-a", draftOnly: true }),
            expect.objectContaining({ documentId: "document-b" }),
          ]),
        );
        expect(getContextTabs("project-a").selectedTabIdByWork["work-a"]).toBe("document-b");
        expect(currentAddress).toBe("/projects/project-a/@work-a/manuscript/writer-choice.md");
        expect(controller?.inlineReviewMessage).toEqual({
          code: "discard-offline",
          tone: "error",
        });
      },
    );
  });
});
