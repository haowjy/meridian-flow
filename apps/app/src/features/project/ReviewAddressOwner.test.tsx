// @vitest-environment jsdom
/** Address ownership keeps inline review and Editor history on one document. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import { useDraftReviewScopeValue } from "@/features/draft-review/DraftReviewProvider";
import { createReviewScopeFixture, listed, work } from "@/test-support/draft-review-scope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { contextTabFromDraftGroup } from "./context/context-tab-from-draft";
import {
  type AiDraftLaunchTarget,
  EditorReviewHandoffProvider,
  useOpenEditorReview,
} from "./dock/editor-review-handoff";
import { resolvePresentedDocument } from "./presented-document";
import { ReviewAddressOwner } from "./ReviewAddressOwner";
import { gateLiveView } from "./routing/local-document-address";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";

const draft: AiDraftLaunchTarget = {
  workId: "work-1",
  documentId: "document-a",
  itemKey: "draft-a",
  contextLocation: { scheme: "manuscript", path: "chapters/a.md" },
};
let openReview: ((target: AiDraftLaunchTarget) => Promise<void>) | null = null;
type InlineReview = {
  documentId: string;
  itemKey: string;
  completion?: { phase: "pending" | "closed"; documentName: string | null };
};
let setInline: ((inline: InlineReview | null) => void) | null = null;

function CommandCapture() {
  const open = useOpenEditorReview();
  useEffect(() => {
    openReview = open;
  }, [open]);
  return null;
}

function Harness({
  requestedItemKey,
  activeScreen = "context",
  activeScheme = "manuscript",
  activePath = draft.contextLocation.path,
  activeDocumentId,
  onSetItemKey,
  exitInlineReview,
  openContextRoute,
  listed = true,
  container = "editor",
  draftOnly = false,
  admit = vi.fn(),
}: {
  /** The Work's draft list still names the reviewed document. */
  listed?: boolean;
  container?: "editor" | "dock";
  draftOnly?: boolean;
  admit?: (target: AiDraftLaunchTarget) => void;
  requestedItemKey?: string;
  activeScreen?: "chat" | "work" | "context";
  activeScheme?: "manuscript" | null;
  activePath?: string | null;
  activeDocumentId?: string;
  onSetItemKey: (itemKey: string | null) => void;
  exitInlineReview?: () => void;
  openContextRoute: OpenContextRoute;
}) {
  const [inline, updateInline] = useState<InlineReview | null>(null);
  setInline = updateInline;
  const review = useMemo(
    () =>
      ({
        controller: {
          workId: draft.workId,
          inlineReview: inline,
          exitInlineReview: exitInlineReview ?? vi.fn(),
        },
        drafts: { status: "ready" },
        files: [
          {
            documentId: draft.documentId,
            documentName: "A",
            contextLocation: draft.contextLocation,
            draft: {
              itemKey: draft.itemKey,
              documentId: draft.documentId,
              documentName: "A",
              contextLocation: draft.contextLocation,
              status: "active",
              updatedAt: "2026-10-02T00:00:00.000Z",
            },
          },
        ],
        fileForDocument: (documentId: string | null | undefined) =>
          listed && documentId === draft.documentId
            ? {
                documentId: draft.documentId,
                documentName: "A",
                contextLocation: draft.contextLocation,
                draft: { itemKey: draft.itemKey },
              }
            : null,
      }) as unknown as DraftReviewContextValue,
    [exitInlineReview, inline, listed],
  );
  return (
    <EditorReviewHandoffProvider projectId="project-1" openContextRoute={openContextRoute}>
      <CommandCapture />
      <ReviewAddressOwner
        admission="admitted"
        review={review}
        presented={
          activeScreen === "context" || container === "dock"
            ? {
                container,
                documentId: activeDocumentId ?? null,
                scheme: activeScheme,
                path: activePath,
                draftOnly,
                review: requestedItemKey
                  ? { workId: draft.workId, itemKey: requestedItemKey }
                  : null,
              }
            : null
        }
        port={{
          write: (address) => onSetItemKey(address?.itemKey ?? null),
          admit: container === "dock" ? admit : (target) => openReview?.(target),
        }}
      />
    </EditorReviewHandoffProvider>
  );
}

describe("ReviewAddressOwner", () => {
  beforeEach(() => {
    openReview = null;
    setInline = null;
  });

  it("exits inline review when the address resolves to another document at the same path", async () => {
    const exit = vi.fn();
    await withReactRoot(
      <Harness
        activeDocumentId="document-b"
        onSetItemKey={vi.fn()}
        exitInlineReview={exit}
        openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
      />,
      async () => {
        await act(async () =>
          setInline?.({ documentId: draft.documentId, itemKey: draft.itemKey }),
        );
        expect(exit).toHaveBeenCalledOnce();
      },
    );
  });

  describe("a review whose draft the list no longer names", () => {
    it("a cold, unlisted open is still owned: Back to live clears the address instead of reopening", async () => {
      const exit = vi.fn();
      const setItemKey = vi.fn();
      const openContextRoute = vi.fn(async () => ({ kind: "applied" as const }));
      await withReactRoot(
        <Harness
          listed={false}
          activeDocumentId={draft.documentId}
          requestedItemKey={draft.itemKey}
          onSetItemKey={setItemKey}
          exitInlineReview={exit}
          openContextRoute={openContextRoute}
        />,
        async () => {
          await act(async () =>
            setInline?.({ documentId: draft.documentId, itemKey: draft.itemKey }),
          );
          expect(exit).not.toHaveBeenCalled();
          expect(setItemKey).not.toHaveBeenCalled();
          const coldAdmissions = openContextRoute.mock.calls.length;
          await act(async () => setInline?.(null));
          expect(setItemKey).toHaveBeenCalledExactlyOnceWith(null);
          expect(openContextRoute).toHaveBeenCalledTimes(coldAdmissions);
        },
      );
    });
  });

  it("never writes a draft identity on a non-document screen", async () => {
    const exit = vi.fn();
    const setItemKey = vi.fn();
    await withReactRoot(
      <Harness
        activeScreen="chat"
        activeScheme={null}
        activePath={null}
        onSetItemKey={setItemKey}
        exitInlineReview={exit}
        openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
      />,
      async () => {
        await act(async () =>
          setInline?.({ documentId: draft.documentId, itemKey: draft.itemKey }),
        );
        expect(exit).toHaveBeenCalledOnce();
        expect(setItemKey).not.toHaveBeenCalledWith(draft.itemKey);
      },
    );
  });

  it("does not compete with its own pending same-document launch", async () => {
    let settle!: () => void;
    const route = new Promise<{ kind: "applied" }>((resolve) => {
      settle = () => resolve({ kind: "applied" });
    });
    const setItemKey = vi.fn();
    await withReactRoot(
      <Harness onSetItemKey={setItemKey} openContextRoute={vi.fn(() => route)} />,
      async () => {
        let pending: Promise<void> | undefined;
        await act(async () => {
          pending = openReview?.(draft);
          setInline?.({ documentId: draft.documentId, itemKey: draft.itemKey });
        });
        expect(setItemKey).not.toHaveBeenCalled();
        settle();
        await act(async () => pending);
      },
    );
  });

  it("keeps an open review while its address resolves, then follows the decision", async () => {
    const exit = vi.fn();
    let resolveAddress!: (documentId: string) => void;
    function Resolving() {
      const [documentId, setDocumentId] = useState<string>();
      resolveAddress = setDocumentId;
      return (
        <Harness
          activePath="chapters/renamed.md"
          activeDocumentId={documentId}
          onSetItemKey={vi.fn()}
          exitInlineReview={exit}
          openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
        />
      );
    }
    await withReactRoot(<Resolving />, async () => {
      await act(async () => setInline?.({ documentId: draft.documentId, itemKey: draft.itemKey }));
      expect(exit).not.toHaveBeenCalled();
      await act(async () => resolveAddress(draft.documentId));
      expect(exit).not.toHaveBeenCalled();
      await act(async () => resolveAddress("document-b"));
      expect(exit).toHaveBeenCalledOnce();
    });
    const fixture = createReviewScopeFixture();
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fixture.network.listWorkDrafts.mockResolvedValue({
      items: [
        {
          ...listed,
          draftId: "whole-draft",
          origin: "created",
          binary: false,
          wholeItem: true,
          conflict: null,
          settling: false,
          tokens: { locationToken: "location", liveTextToken: null, branchGenerationToken: null },
          contextLocation: { scheme: "manuscript", path: "/chapter.md" },
          isNew: true,
        },
      ],
    });
    fixture.network.getDraftPreview.mockResolvedValue({ status: "gone", itemKey: "draft-a" });
    useContextTabsStore.setState({ _reviewOverlayByProject: {}, byProject: {} });
    useContextTabsStore.getState().openTab(
      "project-a",
      contextTabFromDraftGroup({
        workId: "work-a",
        documentId: "document-a",
        itemKey: "draft-a",
        contextLocation: { scheme: "manuscript", path: "/chapter.md" },
        isNew: true,
      })!,
    );
    let refresh!: () => void;
    let selected!: ReturnType<typeof useDraftReviewScopeValue>;
    let address: string | undefined;
    function PendingAddress() {
      const [fetching, setFetching] = useState(false);
      const [itemKey, setItemKey] = useState<string | undefined>("draft-a");
      refresh = () => setFetching(true);
      address = itemKey;
      const gate = gateLiveView(
        {
          kind: "current",
          document: { kind: "available", documentId: "document-a" },
        } as Parameters<typeof gateLiveView>[0],
        {
          catalog: { normalized: { entries: new Map() } },
          isComplete: true,
          isFetching: fetching,
          isError: false,
        } as unknown as Parameters<typeof gateLiveView>[1],
        {
          status: "ready",
          files: [{ documentId: "document-a", isNew: true, draft: { itemKey: "draft-a" } }],
        } as Parameters<typeof gateLiveView>[2],
        () => false,
      );
      const documentId =
        gate.result && gate.result.kind !== "unavailable"
          ? gate.result.document.documentId
          : undefined;
      const presented = resolvePresentedDocument({
        phone: false,
        screen: "context",
        dock: null,
        editor: {
          workId: "work-a",
          scheme: "manuscript",
          path: "/chapter.md",
          documentId,
          itemKey,
          draftOnly: getContextTabs("project-a").tabs.some(
            (tab) =>
              tab.kind === "tracked" &&
              tab.draftOnly &&
              tab.documentId === documentId &&
              tab.reviewWorkId === "work-a",
          ),
        },
      });
      selected = useDraftReviewScopeValue({ projectId: "project-a", work, presented });
      return (
        <ReviewAddressOwner
          admission="admitted"
          review={selected}
          presented={presented}
          port={{
            write: (review) => setItemKey(review?.itemKey),
            admit: (target) =>
              selected.controller.enterInlineReview(target.documentId, target.itemKey),
          }}
        />
      );
    }
    try {
      await withReactRoot(
        <QueryClientProvider client={query}>
          <PendingAddress />
        </QueryClientProvider>,
        async () => {
          await vi.waitFor(() => expect(selected.controller.reviewRoomError).toBe(true));
          expect(address).toBe("draft-a");
          await act(async () => refresh());
          expect(selected.controller.inlineReview?.itemKey).toBe("draft-a");
          expect(address).toBe("draft-a");
          expect(
            getContextTabs("project-a").tabs.find((tab) => tab.documentId === "document-a"),
          ).toHaveProperty("draftOnly", true);
        },
      );
    } finally {
      fixture.dispose();
      query.clear();
    }
  });
});

it.each([
  false,
  true,
])("dock admission and Back to live respect intrinsic draft-only=%s", async (draftOnly) => {
  const admit = vi.fn();
  const write = vi.fn();
  const route = vi.fn(async () => ({ kind: "applied" as const }));
  await withReactRoot(
    <Harness
      container="dock"
      draftOnly={draftOnly}
      activeScreen="chat"
      activeDocumentId={draft.documentId}
      requestedItemKey={draft.itemKey}
      admit={admit}
      onSetItemKey={write}
      openContextRoute={route}
    />,
    async () => {
      expect(admit).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: draft.documentId, itemKey: draft.itemKey }),
      );
      expect(route).not.toHaveBeenCalled();
      await act(async () => setInline?.({ documentId: draft.documentId, itemKey: draft.itemKey }));
      await act(async () => setInline?.(null));
      if (draftOnly) expect(write).not.toHaveBeenCalledWith(null);
      else expect(write).toHaveBeenLastCalledWith(null);
    },
  );
});
