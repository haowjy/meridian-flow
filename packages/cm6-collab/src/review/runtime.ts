import * as Y from "yjs";
import type { Proposal } from "../proposals/contracts";
import type {
  ProposalReviewModel,
  ProposalReviewSnapshot,
  ProposalReviewUnavailable,
  ProposalReviewUnavailableReason,
} from "./contracts";

export interface CreateProposalReviewRuntimeOptions {
  ydoc: Y.Doc;
  textKey?: string;
}

export class ProposalReviewRuntime {
  private readonly ydoc: Y.Doc;
  private readonly textKey: string;

  constructor(options: CreateProposalReviewRuntimeOptions) {
    this.ydoc = options.ydoc;
    this.textKey = options.textKey ?? "content";
  }

  deriveProposalReview(proposal: Proposal): ProposalReviewModel {
    const baseText = this.currentText();

    if (proposal.yjsUpdate == null || proposal.yjsUpdate.length === 0) {
      return this.unavailable(proposal, baseText, "missing_update", "Proposal update payload is unavailable.");
    }

    const update = decodeBase64Update(proposal.yjsUpdate);
    if (update == null) {
      return this.unavailable(
        proposal,
        baseText,
        "invalid_update",
        "Proposal update payload is not valid base64.",
      );
    }

    try {
      const nextDoc = cloneDoc(this.ydoc);
      Y.applyUpdate(nextDoc, update);
      const proposedText = nextDoc.getText(this.textKey).toString();

      // Normalize for prose-first diff display (deterministic, display-only)
      // This reduces visual noise without mutating persisted data
      const normalizedBase = normalizeForDiff(baseText);
      const normalizedProposed = normalizeForDiff(proposedText);

      return {
        availability: "ready",
        proposal,
        baseText: normalizedBase,
        proposedText: normalizedProposed,
        hasChanges: normalizedProposed !== normalizedBase,
      };
    } catch {
      return this.unavailable(
        proposal,
        baseText,
        "update_apply_failed",
        "Proposal update payload could not be applied to current document state.",
      );
    }
  }

  deriveProposalReviews(proposals: Iterable<Proposal>): ProposalReviewSnapshot {
    const reviews = new Map<string, ProposalReviewModel>();
    for (const proposal of proposals) {
      reviews.set(proposal.id, this.deriveProposalReview(proposal));
    }

    return { reviews };
  }

  private currentText(): string {
    return this.ydoc.getText(this.textKey).toString();
  }

  private unavailable(
    proposal: Proposal,
    baseText: string,
    reason: ProposalReviewUnavailableReason,
    message: string,
  ): ProposalReviewUnavailable {
    return {
      availability: "unavailable",
      proposal,
      baseText,
      reason,
      message,
    };
  }
}

export function createProposalReviewRuntime(
  options: CreateProposalReviewRuntimeOptions,
): ProposalReviewRuntime {
  return new ProposalReviewRuntime(options);
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const cloned = new Y.Doc();
  Y.applyUpdate(cloned, Y.encodeStateAsUpdate(source));
  return cloned;
}

function decodeBase64Update(encoded: string): Uint8Array | null {
  try {
    const base64 = normalizeBase64(encoded);
    const raw = globalThis.atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function normalizeBase64(value: string): string {
  if (value.length % 4 === 0) {
    return value;
  }

  return value.padEnd(value.length + (4 - (value.length % 4)), "=");
}

/**
 * Normalize text for prose-first diff display.
 * Deterministic, display-only normalization that reduces visual noise
 * without mutating persisted proposal payloads.
 *
 * Normalizations:
 * - Trim trailing whitespace from each line (preserves paragraph structure)
 * - Normalize line endings to \n
 * - Trim trailing newlines at end of document
 */
function normalizeForDiff(text: string): string {
  return (
    text
      // Normalize all line endings to \n
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Trim trailing whitespace from each line
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Trim trailing newlines at end of document
      .replace(/\n+$/, "")
  );
}
