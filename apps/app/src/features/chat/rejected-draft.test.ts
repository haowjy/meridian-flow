// @vitest-environment jsdom
/**
 * Edit recovery honesty: focus the composer, restore plain text only when the
 * composer is empty and the rejected fingerprint has no structured payload, and
 * never overwrite a live draft.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExistingThreadChatSubmission } from "@/client/chat-submissions";
import { plainComposerDoc } from "@/components/app/composer/composer-document";
import {
  canRestoreRejectedDraft,
  type RejectedDraftComposer,
  restoreRejectedDraft,
} from "./rejected-draft";

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

const REFERENCE = {
  documentId: "document:1",
  uri: "context://project/p/document:1",
  purpose: "reference",
} as unknown as ExistingThreadChatSubmission["references"][number];

function fakeComposer(hasContent: boolean) {
  const restoreSnapshot = vi.fn(
    (_snapshot: Parameters<RejectedDraftComposer["restoreSnapshot"]>[0]) => true,
  );
  const focus = vi.fn();
  return { hasContent: () => hasContent, restoreSnapshot, focus } satisfies RejectedDraftComposer;
}

describe("rejected-draft edit recovery", () => {
  it("restores the stored text into an empty composer and focuses it", () => {
    const composer = fakeComposer(false);

    restoreRejectedDraft(composer, fingerprint({ text: "Hello\nWorld" }));

    expect(composer.restoreSnapshot).toHaveBeenCalledTimes(1);
    expect(composer.restoreSnapshot.mock.calls[0]?.[0]).toMatchObject({
      doc: plainComposerDoc("Hello\nWorld"),
    });
    expect(composer.focus).toHaveBeenCalledTimes(1);
  });

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

  it("classifies which rejected fingerprints can be rebuilt faithfully", () => {
    expect(canRestoreRejectedDraft(fingerprint())).toBe(true);
    expect(canRestoreRejectedDraft(fingerprint({ references: [REFERENCE] }))).toBe(false);
    expect(canRestoreRejectedDraft(fingerprint({ activatedSkillSlugs: ["summarize"] }))).toBe(
      false,
    );
  });
});
