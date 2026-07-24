/** Explicit behavior-preserving stubs for compositions without optional integrations. */

import type { TurnReversalAccess } from "../contracts.js";
import type { DocumentProjectionDiagnostics } from "../domain/document-projection-refresher.js";
import type {
  PostDurabilityNoticeService,
  ReversalNoticeDiagnostics,
} from "../domain/reversal-notices.js";
import type { TurnReversalServiceDeps } from "../domain/turn-reversal-service.js";

function threadContextReversalUnsupported(): never {
  throw new Error("Thread context reversal is not configured");
}

export const UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS = {
  agentEdit: {
    async reverse() {
      return threadContextReversalUnsupported();
    },
  },
  async listEditedDocumentsForTurn() {
    return threadContextReversalUnsupported();
  },
  documentAccess: {
    async canAccessDocument() {
      return threadContextReversalUnsupported();
    },
    async canAccessProjectDocument() {
      return threadContextReversalUnsupported();
    },
  },
  threadContext: {
    async requireThreadOwner() {
      return threadContextReversalUnsupported();
    },
    async resolveContextDocument() {
      return threadContextReversalUnsupported();
    },
  },
} satisfies Pick<
  TurnReversalServiceDeps,
  "agentEdit" | "documentAccess" | "listEditedDocumentsForTurn" | "threadContext"
>;

export const UNSUPPORTED_REVERSE_THREAD_CONTEXT: TurnReversalAccess["reverseThreadContext"] =
  async () => threadContextReversalUnsupported();

export const SILENT_POST_DURABILITY_NOTICES: PostDurabilityNoticeService = {
  async recordAwarenessDegraded() {},
  async recordLateSweep() {},
};

export const SILENT_DOCUMENT_PROJECTION_DIAGNOSTICS: DocumentProjectionDiagnostics = {
  failed() {},
  payload() {
    return {};
  },
};

export const SILENT_REVERSAL_NOTICE_DIAGNOSTICS: ReversalNoticeDiagnostics = {
  documentUriMissing() {},
  recordFailedAfterDurability() {},
  degradedRecordFailedAfterDurability() {},
};
