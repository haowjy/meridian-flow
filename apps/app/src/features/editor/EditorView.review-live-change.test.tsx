// @vitest-environment jsdom
/**
 * A review learns that the draft changed under it, from the real provider
 * outward: controller, query cache and `useInlineReviewSync` are real; the
 * network and document sessions are the only seams. Another tab's Apply
 * changes live beneath the review; its changed preview must reach actual
 * manuscript marks even if the host rerenders during the debounce.
 */

import type { Editor } from "@tiptap/core";
import { act, useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import * as account from "@/features/project/context/account-feature-context";
import {
  createReviewScopeFixture,
  listed,
  previewOf,
  work,
} from "@/test-support/draft-review-scope";
import { registry, sessionFor } from "@/test-support/editor-session-fakes";
import { posOf, rel } from "@/test-support/inline-review-editor";

let fixture: ReturnType<typeof createReviewScopeFixture>;
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [], isError: false, isFetching: false }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ noWork: { id: "no-work", slug: null, archivedAt: null }, works: [] }),
}));
vi.mock("@/features/change-trail/trail-detail-query", () => ({
  usePrefetchTrailDetails: () => {},
}));
vi.mock("@/features/links", async () => ({
  useLinkFollower: (await import("@/features/links/use-link-follower")).useLinkFollower,
  useLinkableDocuments: () => ({ documents: [], revision: "", complete: false }),
}));
vi.mock("./references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("./useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const { EditorView } = await import("./EditorView");

const documentId = "document-a";
let review: ReturnType<typeof useDraftReview> | null = null;
let rerenderHost: () => void = () => {};

function Host() {
  const value = useDraftReview();
  const [, setTick] = useState(0);
  // The hosts tell the review which live document the editor holds (`ActiveEditorProjection`);
  // the review owner watches it for changes made elsewhere.
  const owner = useRef({});
  const { setActiveEditorDocumentId } = value;
  useEffect(() => {
    setActiveEditorDocumentId(documentId, sessionFor(documentId), true, owner.current);
    return () => setActiveEditorDocumentId(null, null, false, owner.current);
  }, [setActiveEditorDocumentId]);
  rerenderHost = () => setTick((tick) => tick + 1);
  review = value;
  return (
    <EditorView
      documentId={documentId}
      projectId="project-a"
      session={sessionFor(documentId)}
      onReviewRoomStale={value.controller.reviewRoomStale}
      reviewWorkId={work.id}
      reviewDraftId={value.controller.inlineReview?.draftId}
      reviewRoomName={value.controller.reviewRoomName ?? undefined}
    />
  );
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  fixture = createReviewScopeFixture({
    registry: registry as unknown as LiveDocumentSessionRegistry,
  });
  vi.spyOn(account, "useAccountResourceProjection").mockReturnValue({
    snapshot: null,
    folders: [],
    records: [],
    error: null,
  });
  resetDraftCommandRecords();
  review = null;
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  fixture.network.getDraftPreview.mockResolvedValue(previewOf("1", "2"));
});
afterEach(() => {
  fixture.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a review whose draft changed under it", () => {
  it("updates manuscript marks after a remote live change despite host rerenders during debounce", async () => {
    await fixture.render(
      async () => {
        await act(async () => review?.controller.enterInlineReview(documentId, "draft-a"));
        await advance(1);
        await advance(1);
        expect(review?.controller.inlineReview?.previewIdentity).toBeDefined();
        const editor = [
          ...document.querySelectorAll<HTMLElement & { editor?: Editor }>(".ProseMirror"),
        ].find((dom) => !dom.closest(".hidden"))?.editor;
        if (!editor) throw new Error("no visible review editor");
        await act(async () => {
          editor.commands.insertContent("alpha beta");
        });
        const encoded = (at: number) =>
          btoa(String.fromCharCode(...Y.encodeRelativePosition(rel(editor, at))));
        const markedPreview = (ids: string[]) => ({
          ...previewOf(...ids),
          hunks: ids.map((id) => {
            const from = posOf(editor, id === "1" ? "alpha" : "beta");
            const to = from + (id === "1" ? 5 : 4);
            return {
              kind: "text" as const,
              hunkId: `h-${id}`,
              operationIds: [id],
              anchor: { relStart: encoded(from), relEnd: encoded(to) },
              spans: [{ operationId: id, anchorFrom: encoded(from), anchorTo: encoded(to) }],
            };
          }),
        });
        const marks = () =>
          [...editor.view.dom.querySelectorAll(".meridian-review-added")].map(
            (el) => el.textContent,
          );
        fixture.network.getDraftPreview.mockResolvedValue(markedPreview(["1", "2"]));
        await advance(501);
        await advance(1);
        expect(marks()).toEqual(["alpha", "beta"]);

        fixture.network.getDraftPreview.mockResolvedValue({
          ...markedPreview(["2"]),
          liveRevisionToken: "live-2",
        });
        await act(async () => sessionFor(documentId).document.getMap("remote").set("applied", "1"));
        await act(async () => rerenderHost());
        await act(async () => rerenderHost());
        await advance(499);
        expect(marks()).toEqual(["alpha", "beta"]);
        await advance(2);
        await advance(1);
        expect(marks()).toEqual(["beta"]);
        expect(review?.controller.inlineReview?.previewIdentity).toContain("live-2");
        expect(editor.getText()).toBe("alpha beta");
      },
      { surface: <Host /> },
    );
  });
});
