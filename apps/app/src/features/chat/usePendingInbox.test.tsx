// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadTransport, ThreadTransportHandlers } from "@/core/transport";
import { writerTurnQueueStatus } from "./pending-inbox";
import { usePendingInbox } from "./usePendingInbox";

const harness = vi.hoisted(() => ({ transport: null as ThreadTransport | null }));
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => harness.transport,
}));

const subscriptions: Array<{
  threadId: string;
  handlers: ThreadTransportHandlers;
  active: boolean;
}> = [];
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
    ],
  };
}

describe("mounted pending inbox owner", () => {
  afterEach(() => {
    subscriptions.length = 0;
  });

  it("replaces queued with waiting, clears on ack, and ignores an old thread epoch", async () => {
    harness.transport = transport;
    const host = document.createElement("div");
    const root = createRoot(host);
    function Probe({ threadId }: { threadId: string }) {
      const pending = usePendingInbox({ threadId, seed: null });
      return createElement("output", null, writerTurnQueueStatus(pending).get("turn-1") ?? "clear");
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
      expect(host.textContent).toBe(expected);
    };

    await act(async () => root.render(createElement(Probe, { threadId: "old" })));
    await act(async () => root.render(createElement(Probe, { threadId: "new" })));
    expect(subscriptions[1]?.active).toBe(true);
    await deliver(0, inbox("waiting"), "clear"); // stale thread epoch
    await deliver(1, inbox("waiting"), "queued");
    await deliver(1, inbox("awaiting_run"), "waiting");
    await deliver(1, { items: [] }, "clear");

    await act(async () => root.unmount());
    host.remove();
  });
});
