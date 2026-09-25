// @vitest-environment jsdom

import type { Turn } from "@meridian/contracts/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadTransport, ThreadTransportHandlers } from "@/core/transport";
import { writerTurnQueueStatus } from "./pending-inbox";
import { UserTurn } from "./UserTurn";
import { usePendingInbox } from "./usePendingInbox";

vi.mock("@/client/stores", () => ({ useIsThreadPendingCreation: () => false }));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => () => undefined,
  useProjectDocumentNavigationProjectId: () => null,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => children,
}));

const harness = vi.hoisted(() => ({ transport: null as ThreadTransport | null }));
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => harness.transport,
}));

const subscriptions: Array<{
  threadId: string;
  handlers: ThreadTransportHandlers;
  active: boolean;
}> = [];
const cleanups: Array<() => Promise<void>> = [];
const transport = {
  subscribe(threadId: string, handlers: ThreadTransportHandlers) {
    const entry = { threadId, handlers, active: true };
    subscriptions.push(entry);
    return () => {
      entry.active = false;
    };
  },
} as unknown as ThreadTransport;

function inbox(state: "waiting" | "awaiting_run") {
  return {
    items: [
      {
        id: "turn-1",
        seq: 1,
        intent: "message",
        provenance: { kind: "writer", actorId: "writer" },
        deliveryState: state,
        summary: "follow-up",
        enqueuedAt: "now",
      },
      {
        id: "child-note",
        seq: 2,
        intent: "notification",
        provenance: { kind: "child", threadId: "child", reportId: "child-run" },
        deliveryState: "waiting",
        summary: "child report notification",
        enqueuedAt: "now",
      },
    ],
  };
}

describe("mounted pending inbox owner", () => {
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    } finally {
      subscriptions.length = 0;
    }
  });

  it("replaces queued with waiting, clears on ack, and ignores an old thread epoch", async () => {
    harness.transport = transport;
    const host = document.createElement("div");
    const root = createRoot(host);
    let mounted = false;
    cleanups.push(async () => {
      if (mounted) await act(async () => root.unmount());
      host.remove();
    });
    function Probe({ threadId }: { threadId: string }) {
      const pending = usePendingInbox({ threadId, seed: null });
      const queueStatus = writerTurnQueueStatus(pending).get("turn-1");
      return createElement(UserTurn, {
        turn: {
          id: "turn-1",
          threadId,
          role: "user",
          status: "complete",
          blocks: [{ id: "block-1", sequence: 0, blockType: "text", textContent: "follow-up" }],
        } as Turn,
        queueStatus,
      });
    }
    const deliver = async (
      owner: number,
      value: ReturnType<typeof inbox> | { items: [] },
      expected: string,
    ) => {
      await act(async () =>
        subscriptions[owner]?.handlers.onEvent({
          seq: String(owner + 1),
          event: { type: "CUSTOM", name: "meridian.inbox.changed", value } as never,
        }),
      );
      expect(host.querySelector("[data-user-turn-status]")?.textContent).toBe(
        expected === "clear"
          ? undefined
          : expected === "queued"
            ? "Queued"
            : "Waiting for response",
      );
      expect(host.textContent).not.toContain("child report notification");
    };

    mounted = true;
    await act(async () => root.render(createElement(Probe, { threadId: "old" })));
    await act(async () => root.render(createElement(Probe, { threadId: "new" })));
    expect(subscriptions[1]?.active).toBe(true);
    await deliver(0, inbox("waiting"), "clear"); // stale thread epoch
    await deliver(1, inbox("waiting"), "queued");
    await deliver(1, inbox("awaiting_run"), "waiting");
    await deliver(1, { items: [] }, "clear");

    await act(async () => root.unmount());
    mounted = false;
  });
});
