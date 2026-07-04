import type { ReviewOperation } from "@meridian/contracts/drafts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OrderedOperation } from "./DraftReviewSidebar";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { AcceptConfirmContent, operationNeedsAcceptConfirm } = await import("./DraftReviewSidebar");

function operation(input: Partial<ReviewOperation> & { operationId: string }): ReviewOperation {
  return {
    rejectSourceUpdateIds: [],
    kind: "agent",
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
    ...input,
  };
}

function entry(op: ReviewOperation): OrderedOperation {
  return {
    operation: op,
    hunks: [],
    firstPos: 1,
    shape: "insert",
    hasOwnDeletion: false,
    includesWriterEdits: false,
  };
}

describe("DraftReviewSidebar accept confirmation", () => {
  it("renders dragged proposal copy with one-line previews", () => {
    const html = renderToStaticMarkup(
      <AcceptConfirmContent
        hasOverlap={false}
        acceptClosureEntries={[
          entry(
            operation({
              operationId: "op-1",
              afterExcerpt: "Silver light filled the room.",
            }),
          ),
          entry(
            operation({
              operationId: "op-2",
              classification: "rewrite",
              contribution: "rewrote",
              beforeExcerpt: "The old oath",
              afterExcerpt: "The new vow",
            }),
          ),
        ]}
      />,
    );

    expect(html).toContain("This also accepts:");
    expect(html).toContain("Silver light filled the room.");
    expect(html).toContain("The old oath");
    expect(html).toContain("The new vow");
  });

  it("renders combined closure and overlap consequence copy", () => {
    const html = renderToStaticMarkup(
      <AcceptConfirmContent
        hasOverlap={true}
        acceptClosureEntries={[
          entry(operation({ operationId: "op-1", afterExcerpt: "Blue flame" })),
        ]}
      />,
    );

    expect(html).toContain(
      "This also accepts the related proposals and applies your latest edits in the same passage.",
    );
    expect(html).toContain("Blue flame");
  });

  it("does not require first-click confirmation for a single-operation accept", () => {
    expect(operationNeedsAcceptConfirm(operation({ operationId: "op-1" }))).toBe(false);
  });
});
