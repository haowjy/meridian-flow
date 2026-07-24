/** Explicit behavior-preserving stubs for compositions without optional integrations. */

import type { DocumentProjectionDiagnostics } from "../domain/document-projection-refresher.js";
import type {
  PostDurabilityNoticeService,
  ReversalNoticeDiagnostics,
} from "../domain/reversal-notices.js";

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
