// @vitest-environment jsdom
/** Draft-only Discard closes its tab at once; a refusal leaves it closed and holds the error on the draft. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { contextTabFromFile } from "@/features/project/context/context-tab-from-file";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import type { ProjectSearch } from "@/features/project/routing/project-route";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  draftCommandErrorKey,
  resetDraftCommandErrors,
  useDraftCommandErrors,
} from "./draft-command-errors";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

let rejectDiscard: ((reason: unknown) => void) | null = null;
let currentAddress = "";
let coordinator: ContextRemovalCoordinator;
let addressWrites = 0;
let search: ProjectSearch;

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
  useContextRemovalCoordinator: () => coordinator,
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
let heldErrors: ReturnType<typeof useDraftCommandErrors> = {};

function heldError() {
  return heldErrors[draftCommandErrorKey({ documentId: "document-a", draftId: "draft-a" })];
}

function CaptureController() {
  controller = useDraftReviewController("project-a", "work-a");
  heldErrors = useDraftCommandErrors();
  return null;
}

function Providers({ children, open }: { children: ReactNode; open: OpenContextRoute }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ProjectNavigationProvider openContextRoute={open} screen="context">
        {children}
      </ProjectNavigationProvider>
    </QueryClientProvider>
  );
}

describe("draft-only Discard", () => {
  beforeEach(() => {
    controller = null;
    rejectDiscard = null;
    currentAddress = "/projects/project-a/@work-a/manuscript/chapter.md";
    addressWrites = 0;
    resetDraftCommandErrors();
    search = {
      screen: "context",
      work: "work-a",
      scheme: "manuscript",
      path: "/chapter.md",
    };
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
    const route = {
      readSearch: () => search,
      updateSearch: (_projectId: string, update: (value: ProjectSearch) => ProjectSearch) => {
        search = update(search);
        addressWrites += 1;
        currentAddress = search.path
          ? `/projects/project-a/@work-a/manuscript/${search.path.replace(/^\/+/, "")}`
          : "/projects/project-a/@work-a/editor";
      },
      transition: async () => ({ kind: "applied" as const }),
    };
    coordinator = new ContextRemovalCoordinator("account-a", { route });
    coordinator.registerRoutePort("project-a", route, "work-a");
    const revision = coordinator.beginRouteSelection("project-a", {
      scheme: "manuscript",
      path: "/chapter.md",
      workId: "work-a",
    });
    coordinator.bindRouteSelection("project-a", revision, {
      kind: "server",
      documentId: "document-a",
    });
  });

  it("keeps the tab closed and holds the error on the draft when Discard is refused", async () => {
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

        // The tab closes with the click and the neighbour takes over.
        expect(getContextTabs("project-a").tabs).toMatchObject([{ documentId: "document-b" }]);
        expect(currentAddress).toBe("/projects/project-a/@work-a/manuscript/live-neighbor.md");
        expect(addressWrites).toBe(1);

        await act(async () => {
          rejectDiscard?.(new Error("offline"));
          await disposition;
        });

        expect(getContextTabs("project-a").tabs).toMatchObject([{ documentId: "document-b" }]);
        expect(addressWrites).toBe(1);
        expect(open).not.toHaveBeenCalled();
        expect(heldError()).toBe("discard-offline");

        // Retrying clears the held error, and a confirmed Discard leaves none.
        let retry: Promise<unknown> | undefined;
        await act(async () => {
          retry = controller?.discard("document-a", "draft-a");
        });
        expect(heldError()).toBeUndefined();
        await act(async () => {
          rejectDiscard?.(new Error("offline"));
          await retry;
        });
        expect(heldError()).toBe("discard-offline");
        expect(getContextTabs("project-a").tabs).toMatchObject([{ documentId: "document-b" }]);
      },
    );
  });
});
