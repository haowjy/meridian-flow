// @vitest-environment jsdom

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeliveryEvent, DeliveryEventRows } from "./DeliveryEventRows";
import { renderChatSurface } from "./renderChatSurface";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
const event = (id: string, agentName: string, childThreadId: string): DeliveryEvent => ({
  turn: {
    id,
    threadId: "parent",
    completedAt: "2025-01-01T00:00:00.000Z",
    blocks: [],
  } as unknown as Turn,
  childThreadId,
  title: "Review the chapter",
  subagentUpdate: {
    kind: "subagent_update",
    childThreadId,
    handle: `@${agentName.toLowerCase()}`,
    execution: `execution-${id}`,
    agentName,
    outcome: "succeeded",
  },
});

describe("DeliveryEventRows", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("renders a finished child as a shared identity row with a chat door", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        renderChatSurface(
          <DeliveryEventRows events={[event("one", "Scout", "child-one")]} />,
          openThread,
        ),
      ),
    );
    expect(host.querySelector("[data-subagent-finished]")?.textContent).toContain("Scout");
    expect(host.querySelector("[data-subagent-finished]")?.textContent).toContain("finished");
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[aria-label='Open "Scout"']`)?.click(),
    );
    expect(openThread).toHaveBeenCalledWith("child-one");
  });

  it("merges adjacent notices, exposes child ids, and expands into individual doors", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        renderChatSurface(
          <DeliveryEventRows
            events={[event("one", "Scout", "child-one"), event("two", "Scout", "child-two")]}
          />,
          openThread,
        ),
      ),
    );
    const header = host.querySelector<HTMLButtonElement>("[data-subagent-thread-ids]");
    expect(header?.getAttribute("data-subagent-thread-ids")).toBe("child-one child-two");
    expect(header?.textContent).toContain("2 subagents finished");
    await act(async () => header?.click());
    expect(host.querySelectorAll("[data-subagent-thread-id]")).toHaveLength(2);
    expect(host.querySelectorAll(`[aria-label='Open "Scout"']`)).toHaveLength(2);
  });
});
