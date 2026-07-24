/** Explicit behavior-preserving stubs for compositions without optional integrations. */
import type { PostDurabilityNoticeService } from "../domain/reversal-notices.js";

export const SILENT_POST_DURABILITY_NOTICES: PostDurabilityNoticeService = {
  async recordAwarenessDegraded() {},
  async recordLateSweep() {},
};
