/** Model-context notice producer coverage for collab response finalization. */
import { describe, expect, it, vi } from "vitest";
import type { NoticePort } from "../notices/index.js";
import { SILENT_REVERSAL_NOTICE_DIAGNOSTICS } from "./adapters/declared-stubs.js";
import { recordNoticeAfterDurability } from "./domain/reversal-notices.js";

describe("collab model-context notices", () => {
  it("does not turn a durable response into an error when notice recording fails", async () => {
    const recordDegraded = vi.fn(async () => {});
    await expect(
      recordNoticeAfterDurability(
        {
          notices: noticePort(vi.fn()),
          threadId: "thread-1",
          documentIds: ["document-1"],
          kind: "awareness_degraded",
          recordDegraded,
          diagnostics: SILENT_REVERSAL_NOTICE_DIAGNOSTICS,
        },
        async () => {
          throw new Error("notice store unavailable");
        },
      ),
    ).resolves.toBeUndefined();
    expect(recordDegraded).toHaveBeenCalledOnce();
  });
});

function noticePort(record: NoticePort["record"]): NoticePort {
  return {
    record,
    async peek() {
      return [];
    },
    async consume() {},
  };
}
