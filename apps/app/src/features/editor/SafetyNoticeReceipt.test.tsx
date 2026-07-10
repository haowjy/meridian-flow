import type { SafetyNoticeWsMessage } from "@meridian/contracts/protocol";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { SafetyNoticeReceipt } = await import("./SafetyNoticeReceipt");

describe("SafetyNoticeReceipt", () => {
  it("renders when the document transport receives a writer-visible safety notice", async () => {
    let emitNotice: ((notice: SafetyNoticeWsMessage) => void) | undefined;
    const session = new DocumentSession({
      roomKey: "document-1",
      enableIndexedDb: false,
      transportFactory: ({ awareness }) => ({
        awareness,
        subscribeSafetyNotices(listener) {
          emitNotice = listener;
          return () => {
            emitNotice = undefined;
          };
        },
        destroy() {},
      }),
    });

    await withReactRoot(<SafetyNoticeReceipt session={session} />, async () => {
      expect(document.querySelector("[data-safety-notice-receipt]")).toBeNull();

      await act(async () =>
        emitNotice?.({
          type: "safety_notice",
          documentId: "document-1",
          kind: "late_sweep",
          message: "Content was modified — View change",
          data: { beforeContentRef: 42 },
        }),
      );

      expect(document.querySelector("[data-safety-notice-receipt]")?.textContent).toContain(
        "Content was modified",
      );
    });

    await session.destroy();
  });
});
