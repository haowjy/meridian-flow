// @vitest-environment jsdom
/** The divider's states, its controls' names, and what each control calls. */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <div data-markdown>{children}</div>,
}));

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CompactionDivider, type CompactionDividerProps } from "./CompactionDivider";
import { QueuedControlRows } from "./QueuedControlRows";
import type { QueuedControl } from "./thread-controls";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

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

function divider(overrides: Record<string, unknown> = {}): Turn {
  return {
    id: "c",
    role: "compaction",
    status: "complete",
    error: null,
    metadata: { trigger: "manual", controlMessageId: "k" },
    blocks: [
      {
        id: "b",
        blockType: "custom",
        sequence: 0,
        content: {
          kind: "compaction",
          props: { summary: "The keeper counts ships.", tokensBefore: 90, tokensAfter: 20 },
        },
      },
    ],
    ...overrides,
  } as unknown as Turn;
}

async function render(props: Partial<CompactionDividerProps> & { turn: Turn }) {
  await act(async () =>
    root.render(<CompactionDivider phase={null} stopping={false} {...props} />),
  );
}

const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );
const state = () =>
  host.querySelector("[data-compaction-divider]")?.getAttribute("data-compaction-state");

describe("CompactionDivider", () => {
  it("pending: names the phase and stops C through the cancel route", async () => {
    const onStop = vi.fn();
    await render({ turn: divider({ status: "pending", blocks: [] }), phase: "compacting", onStop });
    expect(state()).toBe("pending");
    expect(host.textContent).toContain("Compacting conversation");
    await act(async () => button("Stop compaction")?.click());
    expect(onStop).toHaveBeenCalledWith("c");
  });

  it("pending while stopping: says so and ignores Stop without dropping focus", async () => {
    const onStop = vi.fn();
    await render({
      turn: divider({ status: "pending", blocks: [] }),
      phase: "compacting",
      stopping: true,
      onStop,
    });
    expect(host.textContent).toContain("Stopping compaction");
    const stop = button("Stop compaction");
    expect(stop?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => stop?.click());
    expect(onStop).not.toHaveBeenCalled();
  });

  it("complete: the summary sits behind a disclosure wired to its panel", async () => {
    await render({ turn: divider() });
    const toggle = button("Summary");
    const panel = host.querySelector<HTMLElement>("[data-compaction-summary]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.hidden).toBe(true);
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.hidden).toBe(false);
    expect(panel?.textContent).toContain("The keeper counts ships.");
  });

  it("complete: the summary disclosure is its only control", async () => {
    await render({ turn: divider(), onStop: vi.fn() });
    const names = [...host.querySelectorAll("button")].map(
      (candidate) => candidate.getAttribute("aria-label") ?? candidate.textContent,
    );
    expect(names).toEqual(["Summary"]);
  });

  it("names the section in full and keeps a short label for a narrow column", async () => {
    await render({ turn: divider({ metadata: { trigger: "auto" } }) });
    const section = host.querySelector("[data-compaction-divider]");
    expect(section?.getAttribute("aria-label")).toBe("Conversation compacted automatically");
    const labels = [...(section?.querySelectorAll("span.truncate > span") ?? [])].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["Conversation compacted automatically", "Compacted"]);
  });

  it("keeps keyboard focus in the divider when its Stop leaves", async () => {
    const onStop = vi.fn();
    await render({ turn: divider({ status: "pending" }), phase: "compacting", onStop });
    button("Stop compaction")?.focus();
    expect(document.activeElement).toBe(button("Stop compaction"));
    await render({ turn: divider(), onStop });
    expect(document.activeElement).toBe(button("Summary"));
  });

  it("failed manual: says why on the divider", async () => {
    await render({
      turn: divider({
        status: "error",
        blocks: [],
        error: "This conversation couldn't be compacted. Try again.",
        metadata: { trigger: "manual", reason: "provider_error", phase: "summary" },
      }),
    });
    expect(state()).toBe("failed");
    expect(host.textContent).toContain("Couldn't compact");
    expect(host.textContent).toContain("This conversation couldn't be compacted. Try again.");
  });

  it("nothing to compact: reads calmly, never as an error", async () => {
    // Expected after an automatic compaction took care of what /compact queued for.
    await render({
      turn: divider({
        status: "error",
        blocks: [],
        error: "There is nothing to compact yet.",
        metadata: { trigger: "manual", reason: "nothing_to_compact", phase: "initial_prepare" },
      }),
    });
    const section = host.querySelector("[data-compaction-divider]");
    expect(section?.getAttribute("aria-label")).toBe("There is nothing to compact yet");
    expect(host.textContent).not.toContain("Couldn't compact");
    expect(host.querySelector(".text-destructive")).toBeNull();
  });

  it("failed auto: quiet, no error copy (R3)", async () => {
    await render({
      turn: divider({
        status: "error",
        blocks: [],
        error: "This conversation couldn't be compacted. Try again.",
        metadata: { trigger: "auto", reason: "provider_error", phase: "summary" },
      }),
    });
    expect(host.textContent).toContain("Conversation not compacted");
    expect(host.textContent).not.toContain("Try again");
    expect(host.querySelector(".text-destructive")).toBeNull();
  });

  it("cancelled", async () => {
    await render({ turn: divider({ status: "cancelled", blocks: [] }) });
    expect(host.textContent).toContain("Compaction stopped");
  });
});

describe("QueuedControlRows", () => {
  const compact = (status: QueuedControl["status"]): QueuedControl => ({
    id: "k",
    control: { kind: "compact" },
    status,
  });

  it("renders a queued /compact that says when it runs, with Withdraw and no Stop", async () => {
    const onWithdraw = vi.fn();
    await act(async () =>
      root.render(<QueuedControlRows controls={[compact("queued")]} onWithdraw={onWithdraw} />),
    );
    expect(host.textContent).toContain("Compaction queued. Runs when replies finish.");
    expect(button("Stop")).toBeUndefined();
    await act(async () => button("Withdraw compaction")?.click());
    expect(onWithdraw).toHaveBeenCalledWith(compact("queued"));
  });

  it("says a command already started, without Withdraw, in no live region", async () => {
    await act(async () =>
      root.render(
        <QueuedControlRows controls={[compact("already_started")]} onWithdraw={vi.fn()} />,
      ),
    );
    expect(host.querySelector("[data-queued-control]")?.textContent).toBe(
      "This compaction already started.",
    );
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(button("Withdraw compaction")).toBeUndefined();
  });

  it("keeps a failed withdrawal on the row, withdrawable again", async () => {
    await act(async () =>
      root.render(
        <QueuedControlRows controls={[compact("withdraw_failed")]} onWithdraw={vi.fn()} />,
      ),
    );
    expect(host.textContent).toContain("Couldn't withdraw. Try again.");
    expect(button("Withdraw compaction")).toBeDefined();
  });

  it("keeps a failed enqueue on the item with Retry", async () => {
    const onRetry = vi.fn();
    await act(async () =>
      root.render(<QueuedControlRows controls={[compact("failed")]} onRetry={onRetry} />),
    );
    expect(host.textContent).toContain("Couldn't queue the compaction.");
    await act(async () => button("Retry queueing")?.click());
    expect(onRetry).toHaveBeenCalledWith("k");
  });
});
