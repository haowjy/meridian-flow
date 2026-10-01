// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => ({ subscribe }),
}));
vi.mock("@/client/stores", () => ({ useIsThreadPendingCreation: () => false }));

import type { ThreadLiveState } from "@meridian/contracts/protocol";
import { useThreadActivity } from "./useThreadActivity";

const THREAD = `remount-${crypto.randomUUID()}`;
function Consumer() {
  const { activity } = useThreadActivity({ threadId: THREAD, seed: null });
  return <span>{activity.children.length}</span>;
}

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("shared thread activity", () => {
  let root: Root;
  let host: HTMLDivElement;
  let release: ReturnType<typeof vi.fn>;
  let onLiveState: (state: ThreadLiveState) => void;

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    release = vi.fn();
    subscribe.mockImplementation((_threadId, handlers) => {
      onLiveState = handlers.onLiveState;
      return release;
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    subscribe.mockReset();
  });

  it("retains the latest activity when a header consumer remounts", async () => {
    await act(async () => root.render(<Consumer />));
    await act(async () =>
      onLiveState({
        activity: { children: [{ threadId: "child" }] } as never,
        status: { kind: "asleep" },
        threadId: THREAD,
        runningTurnId: null,
        pending: { items: [] },
        resumeAfterSeq: "0",
      } as ThreadLiveState),
    );
    expect(host.textContent).toBe("1");
    await act(async () => root.render(null));
    await act(async () => root.render(<Consumer />));
    expect(host.textContent).toBe("1");
    expect(subscribe).toHaveBeenCalled();
  });
});
