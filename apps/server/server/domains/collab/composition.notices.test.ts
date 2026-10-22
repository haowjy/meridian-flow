/** Model-context notice producer coverage for collab response finalization. */
import { describe, expect, it, vi } from "vitest";
import type { NoticePort } from "../notices/index.js";
import { SILENT_REVERSAL_NOTICE_DIAGNOSTICS } from "./adapters/declared-stubs.js";
import { createPostDurabilityNoticeService } from "./domain/reversal-notices.js";

describe("collab model-context notices", () => {
  it("does not turn a durable response into an error when notice recording fails", async () => {
    const cause = new Error("notice store unavailable");
    const diagnostic = vi.fn();
    const service = createPostDurabilityNoticeService({
      notices: noticePort(async () => {
        throw cause;
      }),
      documentUriResolver: async () => "manuscript/alpha.md",
      diagnostics: {
        ...SILENT_REVERSAL_NOTICE_DIAGNOSTICS,
        recordFailedAfterDurability: diagnostic,
      },
    });
    await expect(
      service.recordAwarenessDegraded({
        threadId: "thread-1",
        responseId: "response-1",
        documentIds: ["document-1"],
      }),
    ).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith({
      kind: "awareness_degraded",
      threadId: "thread-1",
      responseId: "response-1",
      documentIds: ["document-1"],
      cause,
    });
  });
});

function noticePort(record: NoticePort["record"]): NoticePort {
  return {
    record,
    async peek() {
      return [];
    },
    async consume() {},
    async retractForPushes() {},
  };
}
