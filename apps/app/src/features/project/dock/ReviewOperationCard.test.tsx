/** Review cards expose selective Discard but never imply operation-scoped Apply. */
import type { ReviewOperation } from "@meridian/contracts/drafts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
import { partitionClosureClasses } from "./closure-classes";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { ReviewOperationCard } = await import("./ReviewOperationCard");

describe("ReviewOperationCard", () => {
  it("keeps Apply at the document level", () => {
    const operation: ReviewOperation = {
      operationId: "operation-1",
      rejectSourceUpdateIds: [],
      kind: "agent",
      contribution: "added",
      classification: "addition",
      hunkCount: 1,
    };
    const [proposal] = partitionClosureClasses([operation], []);
    const html = renderToStaticMarkup(
      <ReviewOperationCard
        proposal={proposal}
        controller={
          {
            isDisposing: false,
            pendingInlineDiscardIds: () => new Set(),
            discardOperation: vi.fn(),
          } as unknown as DraftReviewController
        }
        draftId="draft-1"
        isNewDocument={false}
        active={false}
        onFocus={vi.fn()}
      />,
    );

    expect(html).toContain(">Discard</button>");
    expect(html).not.toContain(">Apply</button>");
    expect(html).not.toContain(">Create</button>");
  });
});
