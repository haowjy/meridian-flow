import * as Y from "yjs";
import type { Proposal } from "../proposals/contracts";
import type {
  ProposalReviewUnavailable,
  ProposalReviewUnavailableReason,
} from "./contracts";
import type { EditOp, ReviewHunk } from "./types";
import { extractProposalOpsWithClone } from "./changeset-extractor";
import { groupIntoHunks } from "./hunk-grouper";

export interface CreateProposalReviewRuntimeOptions {
  ydoc: Y.Doc;
  textKey?: string;
}

/**
 * Result of `deriveProposalOperations` when the update is successfully applied.
 */
export interface ProposalOperationsReady {
  availability: "ready";
  proposal: Proposal;
  baseText: string;
  proposedText: string;
  ops: EditOp[];
  hunks: ReviewHunk[];
}

/**
 * Result of `deriveProposalOperations`: either a ready set of operations or
 * an unavailable state (same reasons as `ProposalReviewUnavailable`).
 */
export type ProposalOperationsModel =
  | ProposalOperationsReady
  | ProposalReviewUnavailable;

export class ProposalReviewRuntime {
  private readonly ydoc: Y.Doc;
  private readonly textKey: string;

  constructor(options: CreateProposalReviewRuntimeOptions) {
    this.ydoc = options.ydoc;
    this.textKey = options.textKey ?? "content";
  }

  /**
   * Derive exact Yjs-operation-based review data for a proposal.
   *
   * Operations are extracted directly from the Yjs update delta, preserving
   * exact positions and deleted text.
   *
   * Returns `ProposalOperationsReady` on success or `ProposalReviewUnavailable`
   * on failure.
   *
   * Does NOT mutate the caller's ydoc.
   */
  deriveProposalOperations(proposal: Proposal): ProposalOperationsModel {
    const baseText = this.currentText();

    if (proposal.yjsUpdate == null || proposal.yjsUpdate.length === 0) {
      return this.unavailable(
        proposal,
        baseText,
        "missing_update",
        "Proposal update payload is unavailable.",
      );
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
      // Extract ops and reuse the cloned doc (avoids cloning + applying twice)
      const { ops, clonedDoc } = extractProposalOpsWithClone(
        this.ydoc,
        update,
        this.textKey,
      );
      const hunks = groupIntoHunks(ops, proposal.id, baseText);
      const proposedText = clonedDoc.getText(this.textKey).toString();

      return {
        availability: "ready",
        proposal,
        baseText,
        proposedText,
        ops,
        hunks,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.unavailable(
        proposal,
        baseText,
        "update_apply_failed",
        `Proposal update payload could not be applied to current document state: ${detail}`,
      );
    }
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
