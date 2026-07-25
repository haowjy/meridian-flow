// @vitest-environment jsdom
/** Whole-draft review readiness and failure feedback. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

let inlineReviewMessage: { code: "apply-failed"; tone: "error" } | null = null;
const controller = {
  isDisposing: false,
  isAccepting: false,
  canAcceptReviewedDraft: false,
  staleDraft: null,
  staleDraftMessage: null,
  get inlineReviewMessage() {
    return inlineReviewMessage;
  },
  exitInlineReview: vi.fn(),
  enterInlineReview: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
};
let activeDrafts = [{ draftId: "draft-1" }];

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller,
    reviewableDraftsForDocument: () => ({ visible: activeDrafts, active: activeDrafts }),
  }),
}));

const { DraftReviewHeader } = await import("./DraftReviewHeader");

describe("DraftReviewHeader", () => {
  beforeEach(() => {
    controller.canAcceptReviewedDraft = false;
    controller.enterInlineReview.mockClear();
    activeDrafts = [{ draftId: "draft-1" }];
    inlineReviewMessage = null;
  });

  it("disables Apply until the reviewed preview is available", async () => {
    await withReactRoot(<DraftReviewHeader documentId="document-1" draftId="draft-1" />, () => {
      expect(button("Apply all").disabled).toBe(true);
    });
  });

  it("renders a whole-draft command failure", async () => {
    controller.canAcceptReviewedDraft = true;
    inlineReviewMessage = { code: "apply-failed", tone: "error" };
    await withReactRoot(<DraftReviewHeader documentId="document-1" draftId="draft-1" />, () => {
      expect(document.body.textContent).toContain(
        "Couldn't apply. Check your connection and try again.",
      );
    });
  });

  it("steps between same-document drafts without exiting review", async () => {
    activeDrafts = [{ draftId: "draft-1" }, { draftId: "draft-2" }];
    await withReactRoot(<DraftReviewHeader documentId="document-1" draftId="draft-1" />, () => {
      expect(document.body.textContent).toContain("Draft 1 of 2");
      expect(button("Previous draft").disabled).toBe(true);
      button("Next draft").click();
      expect(controller.enterInlineReview).toHaveBeenCalledWith("document-1", "draft-2");
      expect(controller.exitInlineReview).not.toHaveBeenCalled();
    });
  });
});

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`missing button: ${label}`);
  return found as HTMLButtonElement;
}
