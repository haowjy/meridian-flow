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
  accept: vi.fn(),
  reject: vi.fn(),
};

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller }),
}));

const { DraftReviewHeader } = await import("./DraftReviewHeader");

describe("DraftReviewHeader", () => {
  beforeEach(() => {
    controller.canAcceptReviewedDraft = false;
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
});

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button: ${label}`);
  return found as HTMLButtonElement;
}
