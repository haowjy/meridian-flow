// @vitest-environment jsdom
/** A review restored on a renamed document still enters, whatever path the draft list captured. */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
} from "@/features/draft-review/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ReviewAddressOwner } from "../ReviewAddressOwner";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
  useOpenEditorReview,
} from "./editor-review-handoff";

const documentId = "document-a";
const draftId = "draft-a";
const workId = "work-1";

function Restore({ review }: { review: DraftReviewContextValue }) {
  const admit = useOpenEditorReview();
  return (
    <ReviewAddressOwner
      review={review}
      presented={{
        container: "editor",
        documentId,
        scheme: "manuscript",
        path: "chapters/renamed.md",
        draftOnly: false,
        review: { workId, draftId },
      }}
      port={{ write: vi.fn(), admit }}
    />
  );
}

describe("review restoration after a rename", () => {
  it("enters review at a renamed address although the draft list still names the old path", async () => {
    const enterInlineReview = vi.fn();
    const group = {
      documentId,
      documentName: "A",
      contextPath: "chapters/old-name.md",
      draft: {
        draftId,
        documentId,
        documentName: "A",
        contextPath: "chapters/old-name.md",
        status: "active",
        updatedAt: "2026-10-06T00:00:00.000Z",
      },
    };
    const review = {
      controller: { workId, inlineReview: null, enterInlineReview, exitInlineReview: vi.fn() },
      drafts: { status: "ready" },
      files: [group],
      fileForDocument: (id: string | null | undefined) => (id === documentId ? group : null),
      activeEditorDocumentId: documentId,
    } as unknown as DraftReviewContextValue;
    const navigate = vi.fn(async () => ({ kind: "applied" as const }));

    await withReactRoot(
      <EditorReviewHandoffProvider projectId="project-1" openContextRoute={navigate}>
        <DraftReviewBoundary value={review}>
          <Restore review={review} />
          <EditorReviewIntentClaimant editorWorkId={workId} activeScheme="manuscript" />
        </DraftReviewBoundary>
      </EditorReviewHandoffProvider>,
      async () => {
        await act(async () => undefined);
        expect(navigate).toHaveBeenCalledWith(
          expect.objectContaining({ documentId }),
          expect.objectContaining({ draftId, replaceIfSameDocument: true }),
        );
        expect(enterInlineReview).toHaveBeenCalledWith(documentId, draftId);
      },
    );
  });
});
