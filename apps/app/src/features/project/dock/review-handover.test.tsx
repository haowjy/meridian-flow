// @vitest-environment jsdom
/**
 * Moving from one draft's review to another's, through the real launch handoff,
 * the real review controller and the frame around the page: the review being
 * left stays on screen until the one being opened has painted, and the writer
 * never sees a page with no review header between them. The route is the only
 * fake: it changes at once (navigation first) and the page under it shows a
 * skeleton until the new review is painted, as the app does while the document,
 * its room and its marks arrive.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  DraftReviewBoundary,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/chat/DraftReviewProvider";
import { listed, preview, work } from "@/test-support/draft-review-scope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import {
  type AiDraftLaunchTarget,
  EditorReviewHandoffProvider,
  useOpenEditorReview,
} from "./editor-review-handoff";
import { ReviewHandoverFrame } from "./review-handover";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
}));
vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: vi.fn(),
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const target = (name: string): AiDraftLaunchTarget => ({
  workId: work.id,
  documentId: `document-${name}`,
  draftId: `draft-${name}`,
  contextPath: `/${name}.md`,
  documentName: `Chapter ${name}`,
});
const draftOf = (name: string) => ({
  ...listed,
  documentId: `document-${name}`,
  draftId: `draft-${name}`,
  documentName: `Chapter ${name}`,
});

const routing = {
  document: "document-a",
  listeners: new Set<() => void>(),
  go(documentId: string) {
    routing.document = documentId;
    for (const listener of routing.listeners) listener();
  },
};
let controllerOf: ReturnType<typeof useDraftReview>["controller"] | null = null;
let openReview: ((target: AiDraftLaunchTarget) => Promise<void>) | null = null;

/** What the route paints: the review when it is the one routed to, a skeleton while it settles. */
function Page() {
  const { controller } = useDraftReview();
  controllerOf = controller;
  const command = useOpenEditorReview();
  useEffect(() => {
    openReview = command;
  }, [command]);
  const route = useSyncExternalStore(
    (listener) => {
      routing.listeners.add(listener);
      return () => routing.listeners.delete(listener);
    },
    () => routing.document,
  );
  const review = controller.inlineReview;
  const painted = review?.shown && review.documentId === route;
  return painted ? (
    <>
      <header data-draft-review-header>Header {review.draftId}</header>
      <div data-editor-surface="review">Body {review.draftId}</div>
    </>
  ) : (
    <div data-skeleton>Loading</div>
  );
}

function Scope({ children }: { children: React.ReactNode }) {
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  return <DraftReviewBoundary value={value}>{children}</DraftReviewBoundary>;
}

function render(openContextRoute: OpenContextRoute, run: () => Promise<void>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return withReactRoot(
    <QueryClientProvider client={queryClient}>
      <EditorReviewHandoffProvider projectId="project-a" openContextRoute={openContextRoute}>
        <Scope>
          <ReviewHandoverFrame className="relative">
            <Page />
          </ReviewHandoverFrame>
        </Scope>
      </EditorReviewHandoffProvider>
    </QueryClientProvider>,
    run,
  );
}

/** The header the writer can see: the held copy's while one covers the page, else the page's own. */
const visibleHeader = () => {
  const root = document.querySelector("[data-review-cover]") ?? document;
  return root.querySelector("[data-draft-review-header]")?.textContent ?? null;
};

/** Records the visible header after every DOM change, so a one-frame gap cannot hide. */
function watchHeader() {
  const seen: Array<string | null> = [];
  const observer = new MutationObserver(() => {
    const now = visibleHeader();
    if (seen.at(-1) !== now) seen.push(now);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
}

async function reviewing(name: string) {
  await vi.waitFor(() => expect(controllerOf).not.toBeNull());
  await act(async () => controllerOf?.enterInlineReview(`document-${name}`, `draft-${name}`));
  await act(async () =>
    controllerOf?.setInlineReviewShown(`document-${name}`, `draft-${name}`, true),
  );
  expect(visibleHeader()).toBe(`Header draft-${name}`);
}

/** The new review has been claimed and has painted with its header and marks. */
async function paints(name: string) {
  await act(async () => controllerOf?.enterInlineReview(`document-${name}`, `draft-${name}`));
  await act(async () =>
    controllerOf?.setInlineReviewShown(`document-${name}`, `draft-${name}`, true),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  routing.document = "document-a";
  controllerOf = null;
  openReview = null;
  mocks.listWorkDrafts.mockResolvedValue({
    drafts: [draftOf("a"), draftOf("b"), draftOf("c")],
  });
  mocks.getDraftPreview.mockResolvedValue(preview);
});

describe("moving from one draft's review to another's", () => {
  it("keeps the review being left on screen until the next one has painted, then switches in one step", async () => {
    const navigate = vi.fn<OpenContextRoute>(async (destination) => {
      routing.go(destination.documentId as string);
      return { kind: "applied" };
    });
    await render(navigate, async () => {
      await reviewing("a");
      const header = watchHeader();

      let opening: Promise<void> | undefined;
      await act(async () => {
        opening = openReview?.(target("b"));
        await opening;
      });
      // The route already changed; the page under it is a skeleton, and the review being left covers it.
      expect(routing.document).toBe("document-b");
      expect(document.querySelector("[data-skeleton]")).not.toBeNull();
      expect(document.querySelector("[data-review-cover]")).not.toBeNull();
      expect(visibleHeader()).toBe("Header draft-a");

      // Claimed, but not painted yet: still the review being left.
      await act(async () => controllerOf?.enterInlineReview("document-b", "draft-b"));
      expect(visibleHeader()).toBe("Header draft-a");

      await paints("b");
      expect(document.querySelector("[data-review-cover]")).toBeNull();
      expect(visibleHeader()).toBe("Header draft-b");
      header.stop();
      // Never a page with no review header in between.
      expect(header.seen).not.toContain(null);
    });
  });

  it("keeps the first review across a second move before the first has painted", async () => {
    const navigate = vi.fn<OpenContextRoute>(async (destination) => {
      routing.go(destination.documentId as string);
      return { kind: "applied" };
    });
    await render(navigate, async () => {
      await reviewing("a");
      const header = watchHeader();
      await act(async () => {
        await openReview?.(target("b"));
      });
      await act(async () => {
        await openReview?.(target("c"));
      });
      expect(visibleHeader()).toBe("Header draft-a");

      await paints("b");
      // b is not the one the writer last asked for: the hold waits for c.
      expect(visibleHeader()).toBe("Header draft-a");
      routing.go("document-c");
      await paints("c");
      expect(visibleHeader()).toBe("Header draft-c");
      header.stop();
      expect(header.seen).not.toContain(null);
    });
  });

  it("shows the page as it is when the move does not happen", async () => {
    const navigate = vi.fn<OpenContextRoute>(async () => ({
      kind: "failed",
      error: new Error("route failed"),
      ticket: {} as never,
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await render(navigate, async () => {
      await reviewing("a");
      await act(async () => {
        await openReview?.(target("b")).catch(() => {});
      });
      expect(document.querySelector("[data-review-cover]")).toBeNull();
    });
  });

  it("holds nothing when no review is painted to hold", async () => {
    const navigate = vi.fn<OpenContextRoute>(async (destination) => {
      routing.go(destination.documentId as string);
      return { kind: "applied" };
    });
    await render(navigate, async () => {
      await vi.waitFor(() => expect(openReview).not.toBeNull());
      await act(async () => {
        await openReview?.(target("b"));
      });
      expect(document.querySelector("[data-review-cover]")).toBeNull();
    });
  });

  it("holds nothing when the review being opened is the one already painted", async () => {
    const navigate = vi.fn<OpenContextRoute>(async () => ({ kind: "applied" }));
    await render(navigate, async () => {
      await reviewing("a");
      await act(async () => {
        await openReview?.(target("a"));
      });
      expect(document.querySelector("[data-review-cover]")).toBeNull();
    });
  });
});
