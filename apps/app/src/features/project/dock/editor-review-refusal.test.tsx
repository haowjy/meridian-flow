// @vitest-environment jsdom
/** Unavailable draft review selectors stay selected without falling back to live documents. */
import { act, useState } from "react";
import { expect, it } from "vitest";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import { EditorReviewHandoffProvider } from "@/features/project/dock/editor-review-handoff";
import {
  bindDocumentAddressReview,
  reviewBoundAddressResult,
} from "@/features/project/routing/document-address-review";
import {
  gateLiveView,
  reconcileDocumentAddress,
} from "@/features/project/routing/local-document-address";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ReviewAddressOwner } from "../ReviewAddressOwner";

// The locator is passed through unparsed; the default scheme and the cross-source one witness it.
it.each([
  "manuscript",
  "user",
] as const)("an unavailable %s review selector stays selected and never admits the live occupant", async (scheme) => {
  const transitions: string[] = [];
  function Harness() {
    const [branch, setBranch] = useState<string | null>("unknown");
    const drafts = { status: "empty", files: [] };
    const binding = bindDocumentAddressReview(branch ?? undefined, "work");
    const remote = branch
      ? { kind: "unavailable" }
      : ({ kind: "current", document: { documentId: "live-occupant" } } as const);
    const reconciled = reconcileDocumentAddress(
      undefined,
      reviewBoundAddressResult(binding, remote as never),
      binding.kind === "plain" ? "live" : "review",
    );
    const gated = gateLiveView(
      reconciled.result,
      { catalog: null, isComplete: true, isFetching: false, isError: false },
      drafts,
      () => false,
      reconciled.view,
    );
    const status =
      gated.result?.kind === "unavailable"
        ? "unavailable"
        : (gated.result?.document.documentId ?? "pending");
    const state = `${branch ?? "plain"}:${status}`;
    transitions.push(state);
    const review = {
      controller: { workId: "work", inlineReview: null },
      drafts,
      files: [],
    } as unknown as DraftReviewContextValue;
    return (
      <EditorReviewHandoffProvider
        projectId="project"
        openContextRoute={async () => ({ kind: "applied" })}
      >
        <ReviewAddressOwner
          admission="unavailable"
          review={review}
          presented={{
            container: "editor",
            documentId: null,
            scheme,
            path: "/Collision",
            review: branch ? { workId: "work", itemKey: branch } : null,
            draftOnly: false,
          }}
          port={{
            write: (next) => setBranch(next?.itemKey ?? null),
            admit: () => {
              throw new Error("must not admit");
            },
          }}
        />
        <output>{state}</output>
      </EditorReviewHandoffProvider>
    );
  }
  await withReactRoot(<Harness />, async () => {
    await act(async () => undefined);
    expect(transitions).toContain("unknown:unavailable");
    expect(document.querySelector("output")?.textContent).toBe("unknown:unavailable");
  });
});
