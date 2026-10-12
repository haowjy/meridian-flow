// @vitest-environment jsdom
/** Unavailable draft review selectors stay selected without falling back to live documents. */
import { CONTEXT_URI_SCHEMES, isDraftedScheme } from "@meridian/contracts/context-uri";
import { act, useState } from "react";
import { expect, it } from "vitest";
import type { DraftReviewContextValue } from "@/features/chat/DraftReviewProvider";
import { EditorReviewAddressOwner } from "@/features/project/dock/EditorReviewAddressOwner";
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

it.each(
  CONTEXT_URI_SCHEMES.filter(isDraftedScheme),
)("an unavailable %s review selector stays selected and never admits the live occupant", async (scheme) => {
  const transitions: string[] = [];
  function Harness() {
    const [branch, setBranch] = useState<string | null>("unknown");
    const drafts = { status: "empty", groups: [] };
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
      groups: [],
    } as unknown as DraftReviewContextValue;
    return (
      <EditorReviewHandoffProvider
        projectId="project"
        openContextRoute={async () => ({ kind: "applied" })}
      >
        <EditorReviewAddressOwner
          reviewAddressAdmission="unavailable"
          review={review}
          requestedDraftId={branch ?? undefined}
          activeScreen="context"
          activeScheme={scheme}
          activePath="/Collision"
          onSetDraftId={setBranch}
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
