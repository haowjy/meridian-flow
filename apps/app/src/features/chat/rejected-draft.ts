/**
 * Edit recovery for a proved rejection.
 *
 * A rejection retains its exact dispatch fingerprint. The composer draft can
 * only be rebuilt faithfully from text: references and skill slugs have no
 * inverse from blocks, so restoring plain text for a structured message would
 * admit a different message than Retry. Edit therefore focuses the composer,
 * restores the stored text only when the composer is empty and the fingerprint
 * is plain text, and never overwrites a live draft.
 */
import type { ExistingThreadChatSubmission } from "@/client/chat-submissions";
import {
  type ComposerDraftSnapshot,
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";

/** The minimal composer surface Edit touches. */
export type RejectedDraftComposer = {
  hasContent: () => boolean;
  restoreSnapshot: (snapshot: ComposerDraftSnapshot) => boolean;
  focus: () => void;
};

/**
 * Whether the rejected message can be rebuilt into a composer draft from its
 * text alone. Structured payloads (references, skills) cannot, so Edit must not
 * fabricate a plain-text draft for them once the live draft is gone.
 */
export function canRestoreRejectedDraft(fingerprint: ExistingThreadChatSubmission): boolean {
  return fingerprint.references.length === 0 && fingerprint.activatedSkillSlugs.length === 0;
}

/**
 * Apply Edit for a rejected message: focus the composer, and restore the stored
 * text only when the composer is empty and the fingerprint is plain-text
 * faithful. A live draft — including a reference-only one — is never replaced.
 */
export function restoreRejectedDraft(
  composer: RejectedDraftComposer,
  fingerprint: ExistingThreadChatSubmission,
): void {
  if (!composer.hasContent() && canRestoreRejectedDraft(fingerprint)) {
    composer.restoreSnapshot(serializeComposerDraft(plainComposerDoc(fingerprint.text)).draft);
  }
  composer.focus();
}
