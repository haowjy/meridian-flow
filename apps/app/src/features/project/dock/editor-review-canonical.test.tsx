// @vitest-environment jsdom
/** A moved review keeps its selector while the server repairs its old source locator. */
import { act, useState } from "react";
import { expect, it } from "vitest";
import type { DraftReviewContextValue } from "@/features/chat/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { EditorReviewAddressOwner } from "./EditorReviewAddressOwner";
import { EditorReviewHandoffProvider } from "./editor-review-handoff";

it.each([
  undefined,
  "document",
])("keeps a moved review with address identity %s", async (documentId) => {
  function Harness() {
    const [draftId, setDraftId] = useState<string | null>("branch");
    const [destination, setDestination] = useState("waiting");
    const group = {
      documentId: "document",
      contextLocation: { scheme: "kb", path: "/Withern" },
      draft: { draftId: "branch" },
    };
    const review = {
      controller: { workId: "work", inlineReview: null },
      drafts: { status: "ready" },
      groups: [group],
    } as unknown as DraftReviewContextValue;
    return (
      <EditorReviewHandoffProvider
        projectId="project"
        openContextRoute={async (target) => {
          setDestination(`${target.scheme}:${target.documentId}`);
          return { kind: "applied" };
        }}
      >
        <EditorReviewAddressOwner
          reviewAddressAdmission="admitted"
          review={review}
          requestedDraftId={draftId ?? undefined}
          activeScreen="context"
          activeScheme="user"
          activePath="/Before"
          activeDocumentId={documentId}
          onSetDraftId={setDraftId}
        />
        <output>
          {draftId ?? "none"}:{destination}
        </output>
      </EditorReviewHandoffProvider>
    );
  }
  await withReactRoot(<Harness />, async () => {
    await act(async () => undefined);
    expect(document.querySelector("output")?.textContent).toBe(
      documentId ? "branch:kb:document" : "branch:waiting",
    );
  });
});
