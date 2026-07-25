// @vitest-environment jsdom
/** Writer-facing refusal evidence and compare navigation. */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

const { DraftApplyRefusalNotice } = await import("./DraftDock");

describe("DraftApplyRefusalNotice", () => {
  it("shows writer and proposed versions and opens the compare surface", async () => {
    const onReview = vi.fn();

    await withReactRoot(
      <DraftApplyRefusalNotice
        refusal={{
          documentId: "document-1",
          draftId: "draft-1",
          reason: "unsynced_live_edits",
          conflictedBlocks: ["block-1"],
          conflicts: [
            {
              blockId: "block-1",
              effect: "overwrite",
              evidence: "human_live_change",
              why: "Apply would overwrite text you changed.",
              base: "The old sentence.",
              live: "The sentence you revised.",
              proposed: "The draft's sentence.",
            },
          ],
        }}
        onReview={onReview}
      />,
      () => {
        expect(document.querySelector('[role="alert"]')).not.toBeNull();
        expect(document.body.textContent).toContain(
          "Not applied: your edit conflicts with this draft",
        );
        expect(document.body.textContent).toContain(
          "You edited this passage after the draft was written.",
        );
        expect(document.body.textContent).toContain("The sentence you revised.");
        expect(document.body.textContent).toContain("The draft's sentence.");
        const evidence = document.querySelector<HTMLElement>("[data-draft-apply-refusal-scroll]");
        const evidenceHeading = document.querySelector<HTMLElement>(
          "[data-draft-apply-refusal-details] summary",
        );
        expect(evidence?.tabIndex).toBe(0);
        expect(evidence?.getAttribute("aria-labelledby")).toBe(evidenceHeading?.id);

        act(() => evidence?.focus());
        expect(document.activeElement).toBe(evidence);

        act(() => {
          button("Compare changes").click();
        });
        expect(onReview).toHaveBeenCalledOnce();
      },
    );
  });
});

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button: ${label}`);
  return found as HTMLButtonElement;
}
