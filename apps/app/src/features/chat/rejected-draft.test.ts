// @vitest-environment jsdom
/**
 * Edit recovery honesty: focus the composer, restore plain text only when the
 * composer is empty and the rejected fingerprint has no structured payload, and
 * never overwrite a live draft.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExistingThreadChatSubmission } from "@/client/chat-submissions";
import { type RejectedDraftComposer, restoreRejectedDraft } from "./rejected-draft";

function fingerprint(
  overrides: Partial<ExistingThreadChatSubmission> = {},
): ExistingThreadChatSubmission {
  return {
    kind: "existing-thread",
    submissionId: "sub-1",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: "2026-09-22T12:00:00.000Z",
    text: "Hello",
    blocks: [{ type: "text", text: "Hello" }],
    references: [],
    activatedSkillSlugs: [],
    ...overrides,
  };
}

function fakeComposer(hasContent: boolean) {
  const restoreSnapshot = vi.fn(
    (_snapshot: Parameters<RejectedDraftComposer["restoreSnapshot"]>[0]) => true,
  );
  const focus = vi.fn();
  return { hasContent: () => hasContent, restoreSnapshot, focus } satisfies RejectedDraftComposer;
}

describe("rejected-draft edit recovery", () => {
  it("never overwrites a non-empty live draft, including a reference-only one", () => {
    const composer = fakeComposer(true);

    restoreRejectedDraft(composer, fingerprint());

    expect(composer.restoreSnapshot).not.toHaveBeenCalled();
    expect(composer.focus).toHaveBeenCalledTimes(1);
  });

  it("does not fabricate plain text for a structured message whose draft is gone", () => {
    const composer = fakeComposer(false);

    restoreRejectedDraft(composer, fingerprint({ activatedSkillSlugs: ["summarize"] }));

    expect(composer.restoreSnapshot).not.toHaveBeenCalled();
    expect(composer.focus).toHaveBeenCalledTimes(1);
  });
});
