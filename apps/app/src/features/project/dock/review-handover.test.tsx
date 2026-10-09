// @vitest-environment jsdom
/**
 * Moving from one draft's review to another's, through the real launch handoff,
 * the real review controller, the real address owner and the frame around the
 * page. The review being left stays on screen until the one being opened has
 * painted, and the writer never sees a page with no review header between them.
 * The hold has one owner: the page under it cannot be acted on, and it ends when
 * the review it waits for paints, fails or is left, when the writer goes
 * somewhere else, or after a fixed time, whether or not any page is mounted.
 *
 * The route is the only fake: it changes at once (navigation first) and the page
 * under it shows a skeleton until the new review is painted, as the app does
 * while the document, its room and its marks arrive.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  DraftReviewBoundary,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { listed, preview, work } from "@/test-support/draft-review-scope";
import { sessionFor } from "@/test-support/editor-session-fakes";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { EditorReviewAddressOwner } from "./EditorReviewAddressOwner";
import {
  type AiDraftLaunchTarget,
  EditorReviewHandoffProvider,
  useOpenEditorReview,
} from "./editor-review-handoff";
import { ReviewHandoverFrame } from "./review-handover";

// Match the account lifetime: rerenders must keep the same registry identity.
const registry = {
  retainBranchRooms: vi.fn(),
  releaseBranchRooms: vi.fn(),
  getBranchRoom: sessionFor,
};

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
  useLiveDocumentSessionRegistry: () => registry,
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

type Route = { screen: "context" | "chat"; document: string; framed: boolean };
const routing = {
  state: { screen: "context", document: "document-a", framed: true } as Route,
  listeners: new Set<() => void>(),
  set(patch: Partial<Route>) {
    routing.state = { ...routing.state, ...patch };
    for (const listener of routing.listeners) listener();
  },
};
const useRoute = () =>
  useSyncExternalStore(
    (listener) => {
      routing.listeners.add(listener);
      return () => routing.listeners.delete(listener);
    },
    () => routing.state,
  );

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
  const route = useRoute().document;
  const review = controller.inlineReview;
  const painted = review?.shown && review.documentId === route;
  return painted ? (
    <>
      <header data-draft-review-header>Header {review.draftId}</header>
      <div data-editor-surface="review">
        Body {review.draftId}
        <button type="button" data-page-control>
          Step
        </button>
      </div>
    </>
  ) : (
    <div data-skeleton>Loading</div>
  );
}

/** The address owner, fed the route the way the project view feeds it. */
function Address() {
  const review = useDraftReview();
  const route = useRoute();
  return (
    <EditorReviewAddressOwner
      review={review}
      activeScreen={route.screen}
      activeScheme="manuscript"
      activePath={`/${route.document}.md`}
      activeDocumentId={route.document}
      onSetDraftId={() => {}}
    />
  );
}

function Shell() {
  const route = useRoute();
  return (
    <>
      <button type="button" data-outside-nav>
        Tab
      </button>
      {route.framed ? (
        <ReviewHandoverFrame className="relative">
          <Page />
        </ReviewHandoverFrame>
      ) : (
        <Page />
      )}
      <Address />
    </>
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
          <Shell />
        </Scope>
      </EditorReviewHandoffProvider>
    </QueryClientProvider>,
    run,
  );
}

/** A route that changes at once, as the address does. */
const navigates: OpenContextRoute = async (destination) => {
  routing.set({ document: destination.documentId as string });
  return { kind: "applied" };
};

const cover = () => document.querySelector("[data-review-cover]");
/** The header the writer can see: the held copy's while one covers the page, else the page's own. */
const visibleHeader = () =>
  (cover() ?? document).querySelector("[data-draft-review-header]")?.textContent ?? null;

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
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
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

async function moveTo(name: string) {
  await act(async () => {
    await openReview?.(target(name));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  routing.state = { screen: "context", document: "document-a", framed: true };
  controllerOf = null;
  openReview = null;
  mocks.listWorkDrafts.mockResolvedValue({
    drafts: [draftOf("a"), draftOf("b"), draftOf("c")],
  });
  mocks.getDraftPreview.mockResolvedValue(preview);
});
afterEach(() => vi.useRealTimers());

describe("moving from one draft's review to another's", () => {
  it("keeps the review being left on screen until the next one has painted, then switches in one step", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      const header = watchHeader();

      await moveTo("b");
      // The route already changed; the page under it is a skeleton, and the review being left covers it.
      expect(routing.state.document).toBe("document-b");
      expect(document.querySelector("[data-skeleton]")).not.toBeNull();
      expect(cover()).not.toBeNull();
      expect(visibleHeader()).toBe("Header draft-a");

      // Claimed, but not painted yet: still the review being left.
      await act(async () => controllerOf?.enterInlineReview("document-b", "draft-b"));
      expect(visibleHeader()).toBe("Header draft-a");

      await paints("b");
      expect(cover()).toBeNull();
      expect(visibleHeader()).toBe("Header draft-b");
      header.stop();
      // Never a page with no review header in between.
      expect(header.seen).not.toContain(null);
    });
  });

  it("keeps the first review across a second move before the first has painted", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      const header = watchHeader();
      await moveTo("b");
      await moveTo("c");
      expect(visibleHeader()).toBe("Header draft-a");

      await paints("b");
      // b is not the one the writer last asked for: the hold waits for c.
      expect(visibleHeader()).toBe("Header draft-a");
      await paints("c");
      expect(visibleHeader()).toBe("Header draft-c");
      header.stop();
      expect(header.seen).not.toContain(null);
    });
  });

  it("shows the page as it is when the move does not happen", async () => {
    const failing = vi.fn<OpenContextRoute>(async () => ({
      kind: "failed",
      error: new Error("route failed"),
      ticket: {} as never,
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await render(failing, async () => {
      await reviewing("a");
      await act(async () => {
        await openReview?.(target("b")).catch(() => {});
      });
      expect(cover()).toBeNull();
    });
  });

  it("holds nothing when no review is painted to hold", async () => {
    await render(navigates, async () => {
      await vi.waitFor(() => expect(openReview).not.toBeNull());
      await moveTo("b");
      expect(cover()).toBeNull();
    });
  });

  it("holds nothing when the review being opened is the one already painted", async () => {
    await render(
      vi.fn<OpenContextRoute>(async () => ({ kind: "applied" })),
      async () => {
        await reviewing("a");
        await moveTo("a");
        expect(cover()).toBeNull();
      },
    );
  });
});

describe("the page being opened while the review being left is held", () => {
  it("cannot be acted on or reached, says it is opening, and leaves navigation outside it usable", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      await moveTo("b");

      const destination = document.querySelector("[data-review-destination]");
      // The real page under the copy: not clickable, focusable or exposed to assistive technology.
      expect(destination?.hasAttribute("inert")).toBe(true);
      expect(document.querySelector("[data-skeleton]")?.closest("[inert]")).toBe(destination);
      expect(cover()?.hasAttribute("inert")).toBe(true);
      // Tabs, sidebar and the rest of the shell are outside the frame.
      expect(document.querySelector("[data-outside-nav]")?.closest("[inert]")).toBeNull();
      // The destination is announced as loading.
      expect(document.querySelector("[data-review-handover-status]")?.textContent).toBe(
        "Opening Chapter b",
      );

      await paints("b");
      expect(destination?.hasAttribute("inert")).toBe(false);
      expect(document.querySelector("[data-review-handover-status]")?.textContent).toBe("");
    });
  });

  it("takes keyboard focus off the page it covers and puts it back on the page when it paints", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      document.querySelector<HTMLElement>("[data-page-control]")?.focus();
      expect(document.activeElement?.hasAttribute("data-page-control")).toBe(true);

      await moveTo("b");
      // Not on something inert, and not dropped on the document.
      expect(document.activeElement).toBe(document.querySelector("[data-review-handover-status]"));

      await paints("b");
      expect(document.activeElement).toBe(document.querySelector("[data-review-handover]"));
    });
  });

  it("leaves focus alone when it was not on the page", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      const outside = document.querySelector<HTMLElement>("[data-outside-nav]");
      outside?.focus();
      await moveTo("b");
      expect(document.activeElement).toBe(outside);
    });
  });
});

describe("the hold belongs to the review it waits for", () => {
  it("ends when the writer goes to another document before the review has painted", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      await moveTo("b");
      await act(async () => controllerOf?.enterInlineReview("document-b", "draft-b"));
      expect(cover()).not.toBeNull();

      // The writer picks a tab: the review being opened is no longer where they are.
      await act(async () => routing.set({ document: "document-c" }));
      expect(cover()).toBeNull();
      expect(document.querySelector("[data-review-destination]")?.hasAttribute("inert")).toBe(
        false,
      );
    });
  });

  it("ends when the writer goes to another document before the claim", async () => {
    // The route is still on a: the move has not reached b yet.
    await render(
      () => new Promise(() => {}),
      async () => {
        await reviewing("a");
        await act(async () => {
          void openReview?.(target("b"));
        });
        expect(cover()).not.toBeNull();
        await act(async () => routing.set({ document: "document-c" }));
        expect(cover()).toBeNull();
      },
    );
  });

  it("ends when the writer leaves the Editor, here to Chat, before the review has painted", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      await moveTo("b");
      expect(cover()).not.toBeNull();
      await act(async () => routing.set({ screen: "chat" }));
      expect(cover()).toBeNull();
    });
  });

  it("ends when the review being opened is left", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      await moveTo("b");
      await act(async () => controllerOf?.enterInlineReview("document-b", "draft-b"));
      await act(async () => controllerOf?.exitInlineReview());
      expect(cover()).toBeNull();
    });
  });

  it("shows a review that failed to load instead of covering it with the review that was left", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      mocks.getDraftPreview.mockRejectedValue(new Error("preview failed"));
      await moveTo("b");
      expect(cover()).not.toBeNull();
      await act(async () => controllerOf?.enterInlineReview("document-b", "draft-b"));
      await vi.waitFor(() => expect(controllerOf?.reviewRoomError).toBe(true));
      expect(cover()).toBeNull();
    });
  });

  it("ends after a fixed time if the review never paints", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      vi.useFakeTimers();
      await moveTo("b");
      expect(cover()).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(9_000));
      expect(cover()).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(2_000));
      expect(cover()).toBeNull();
    });
  });

  it("does not outlive the time it was given because the page hosting it was unmounted and mounted again", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      vi.useFakeTimers();
      await moveTo("b");
      // The phone's document host unmounts when the writer looks elsewhere, and returns later.
      await act(async () => routing.set({ framed: false }));
      await act(async () => vi.advanceTimersByTime(11_000));
      await act(async () => routing.set({ framed: true }));
      expect(cover()).toBeNull();
    });
  });

  it("is not extended by a second move: the time runs from the view that was captured", async () => {
    await render(navigates, async () => {
      await reviewing("a");
      vi.useFakeTimers();
      await moveTo("b");
      await act(async () => vi.advanceTimersByTime(6_000));
      await moveTo("c");
      await act(async () => vi.advanceTimersByTime(5_000));
      expect(cover()).toBeNull();
    });
  });
});
