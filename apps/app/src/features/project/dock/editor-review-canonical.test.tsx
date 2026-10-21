// @vitest-environment jsdom
/** A moved review keeps its selector while the server repairs its old source locator. */
import { act, useState } from "react";
import { expect, it } from "vitest";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ReviewAddressOwner } from "../ReviewAddressOwner";
import { EditorReviewHandoffProvider } from "./editor-review-handoff";

it.each([
  undefined,
  "document",
])("keeps a moved review with address identity %s", async (documentId) => {
  function Harness() {
    const [itemKey, setItemKey] = useState<string | null>("draft");
    const [destination, setDestination] = useState("waiting");
    const group = {
      documentId: "document",
      contextLocation: { scheme: "kb", path: "/Withern" },
      draft: { itemKey: "draft" },
    };
    const review = {
      controller: { workId: "work", inlineReview: null },
      drafts: { status: "ready" },
      files: [group],
    } as unknown as DraftReviewContextValue;
    return (
      <EditorReviewHandoffProvider
        projectId="project"
        openContextRoute={async (target) => {
          setDestination(`${target.scheme}:${target.documentId}`);
          return { kind: "applied" };
        }}
      >
        <ReviewAddressOwner
          admission="admitted"
          review={review}
          presented={{
            container: "editor",
            documentId: documentId ?? null,
            scheme: "kb",
            path: "/Withern",
            review: itemKey ? { workId: "work", itemKey } : null,
            draftOnly: false,
          }}
          port={{
            write: (next) => setItemKey(next?.itemKey ?? null),
            admit: (target) => {
              setDestination(`${target.contextLocation.scheme}:${target.documentId}`);
            },
          }}
        />
        <output>
          {itemKey ?? "none"}:{destination}
        </output>
      </EditorReviewHandoffProvider>
    );
  }
  await withReactRoot(<Harness />, async () => {
    await act(async () => undefined);
    expect(document.querySelector("output")?.textContent).toBe(
      documentId ? "draft:kb:document" : "draft:waiting",
    );
  });
});
