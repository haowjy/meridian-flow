// @vitest-environment jsdom
/** A draft-only document has no live version: its review exit closes the tab instead of going back to live. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftReviewHeader } from "./DraftReviewHeader";

const controller = vi.hoisted(() => ({
  isDisposing: false,
  isApplying: false,
  canApplyReviewedDraft: true,
  inlineReviewMessage: null,
  exitInlineReview: vi.fn(),
  apply: vi.fn(),
  discard: vi.fn(),
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({ useDraftReview: () => ({ controller }) }));

function render(onCloseDraftOnly: (() => void) | undefined, run: () => Promise<void>) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <DraftReviewHeader documentId="doc-a" draftId="draft-a" onCloseDraftOnly={onCloseDraftOnly} />
    </I18nProvider>,
    run,
  );
}

const exitButton = () => document.querySelector<HTMLButtonElement>("section button");

describe("DraftReviewHeader exit", () => {
  it("goes back to live for a live document", async () => {
    await render(undefined, async () => {
      expect(exitButton()?.textContent).toBe("Back to live");
      await act(async () => exitButton()?.click());
      expect(controller.exitInlineReview).toHaveBeenCalledOnce();
    });
  });

  it("closes the tab for a draft-only document, leaving review state to the tab's removal", async () => {
    const close = vi.fn();
    controller.exitInlineReview.mockClear();
    await render(close, async () => {
      expect(exitButton()?.textContent).toBe("Close review");
      await act(async () => exitButton()?.click());
      expect(close).toHaveBeenCalledOnce();
      expect(controller.exitInlineReview).not.toHaveBeenCalled();
    });
  });
});
