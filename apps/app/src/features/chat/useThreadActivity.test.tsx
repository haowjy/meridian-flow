// @vitest-environment jsdom
import { EventType } from "@meridian/contracts/protocol";
import type { ThreadActivity } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => ({ subscribe: mocks.subscribe }),
}));
vi.mock("@/client/stores", () => ({ useIsThreadPendingCreation: () => false }));

import { useThreadActivity } from "./useThreadActivity";

const THREAD_ID = "nested-thread";

describe("useThreadActivity", () => {
  let host: HTMLDivElement;
  let root: Root;
  let activity: ThreadActivity | null;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    activity = null;
    mocks.subscribe.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("applies a nested thread's activity frame as-is", async () => {
    let handlers: { onEvent: (message: never) => void } | undefined;
    mocks.subscribe.mockImplementation((_threadId, nextHandlers) => {
      handlers = nextHandlers;
      return () => {};
    });

    function Reader() {
      activity = useThreadActivity({ threadId: THREAD_ID, seed: null }).activity;
      return null;
    }

    await act(async () => root.render(<Reader />));
    expect(mocks.subscribe).toHaveBeenCalledWith(THREAD_ID, expect.any(Object));

    const frame: ThreadActivity = {
      children: [
        {
          threadId: "direct-child",
          parentThreadId: THREAD_ID,
          ref: null,
          title: "Review the chapter",
          agentName: "Critic",
          spawnStatus: "running",
          status: { kind: "awake", phase: "generating", cancelRequested: false },
          originTurnId: null,
        },
      ],
    };

    await act(async () => {
      handlers?.onEvent({
        event: {
          type: EventType.CUSTOM,
          name: "meridian.subagent.activity",
          value: frame,
        },
      } as never);
    });

    expect(activity).toBe(frame);
  });
});
