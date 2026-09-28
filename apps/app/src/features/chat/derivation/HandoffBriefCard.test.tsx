// @vitest-environment jsdom
/** The brief card in every state: its words, its controls, and what each control calls. */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((out, part, index) => out + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <div data-markdown>{children}</div>,
}));
const source = vi.hoisted(() => ({ trashed: false as boolean | null }));
// A trashed source's current title is unreadable, so the frozen one the card passes stands.
vi.mock("./SourceChatLink", () => ({
  useSourceThread: (_id: string, frozenTitle: string | null) => ({
    title: source.trashed ? frozenTitle : "Chapter 12 plan",
    trashed: source.trashed,
  }),
  SourceChatLink: ({
    title,
    trashed,
    fallbackName,
  }: {
    title: string | null;
    trashed: boolean | null;
    fallbackName: string;
  }) => (
    <span data-source-link>
      {trashed ? `${title ?? fallbackName} (in the trash)` : (title ?? fallbackName)}
    </span>
  ),
}));

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HandoffBriefCard, type HandoffBriefCardProps } from "./HandoffBriefCard";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  source.trashed = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

function seed(status: string, extra: Record<string, unknown> = {}): Turn {
  return {
    id: "s",
    role: "system",
    status,
    error: null,
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "source",
      sourceRef: "c1",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
      controlMessageId: "k",
    },
    blocks:
      status === "complete"
        ? [
            {
              id: "b",
              blockType: "custom",
              sequence: 0,
              content: {
                kind: "handoff-brief",
                props: { state: "available", brief: "Lin Feng reaches the gate." },
              },
            },
          ]
        : [],
    ...extra,
  } as unknown as Turn;
}

async function render(props: Partial<HandoffBriefCardProps> & { turn: Turn }) {
  await act(async () =>
    root.render(
      <HandoffBriefCard latest retryPending={false} stopping={false} phase={null} {...props} />,
    ),
  );
}

const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );
const card = () => host.querySelector("[data-handoff-brief]");

describe("HandoffBriefCard", () => {
  it("generating: says so, links the source, and Stop targets S", async () => {
    const onStop = vi.fn();
    await render({ turn: seed("pending"), phase: "briefing", onStop });
    expect(card()?.getAttribute("data-handoff-brief-state")).toBe("generating");
    expect(card()?.getAttribute("aria-label")).toBe("Writing the handoff brief");
    expect(host.textContent).toContain("Handed off from");
    expect(host.querySelector("[data-source-link]")?.textContent).toBe("Chapter 12 plan");
    await act(async () => button("Stop the handoff brief")?.click());
    expect(onStop).toHaveBeenCalledWith("s");
  });

  it("stopping: keeps the focused Stop, marked aria-disabled, and does not stop twice", async () => {
    const onStop = vi.fn();
    await render({ turn: seed("pending"), stopping: true, onStop });
    expect(card()?.getAttribute("aria-label")).toBe("Stopping the handoff brief");
    const stop = button("Stop the handoff brief");
    expect(stop?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => stop?.click());
    expect(onStop).not.toHaveBeenCalled();
  });

  it("a settled brief drops the stopping words even while the Stop flag lingers", async () => {
    await render({ turn: seed("cancelled"), stopping: true, onRetry: vi.fn() });
    expect(card()?.getAttribute("aria-label")).toBe("Handoff brief stopped");
    expect(button("Retry the handoff brief")?.hasAttribute("data-focus-landing")).toBe(true);
  });

  it("generating before the thread exists: no Stop, since there is no turn to stop yet", async () => {
    await render({ turn: seed("pending") });
    expect(button("Stop the handoff brief")).toBeUndefined();
  });

  it("ready: shows the brief and offers neither Stop nor Retry", async () => {
    await render({ turn: seed("complete"), onStop: vi.fn(), onRetry: vi.fn() });
    expect(card()?.getAttribute("data-handoff-brief-state")).toBe("ready");
    expect(host.querySelector("[data-markdown]")?.textContent).toBe("Lin Feng reaches the gate.");
    expect(button("Stop the handoff brief")).toBeUndefined();
    expect(button("Retry the handoff brief")).toBeUndefined();
  });

  it("failed: the seed's writer copy and Retry, which queues a new brief", async () => {
    const onRetry = vi.fn();
    await render({
      turn: seed("error", { error: "This handoff brief couldn't be generated. Try again." }),
      onRetry,
    });
    expect(card()?.getAttribute("aria-label")).toBe("Handoff brief unavailable");
    expect(host.textContent).toContain("This handoff brief couldn't be generated. Try again.");
    await act(async () => button("Retry the handoff brief")?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("stopped: says the chat continues without a brief, and offers Retry", async () => {
    await render({ turn: seed("cancelled"), onRetry: vi.fn() });
    expect(card()?.getAttribute("aria-label")).toBe("Handoff brief stopped");
    expect(host.textContent).toContain("This chat continues without a brief.");
    expect(button("Retry the handoff brief")).toBeDefined();
  });

  it("an older failed brief says it failed, never to try again: a newer brief replaced it", async () => {
    await render({
      turn: seed("error", { error: "This handoff brief couldn't be generated. Try again." }),
      latest: false,
      onRetry: vi.fn(),
    });
    expect(card()?.getAttribute("aria-label")).toBe("Handoff brief unavailable");
    expect(host.textContent).toContain("This brief failed.");
    expect(host.textContent).not.toContain("Try again");
  });

  it("an older stopped brief does not claim the chat continues without one", async () => {
    await render({ turn: seed("cancelled"), latest: false });
    expect(card()?.getAttribute("aria-label")).toBe("Handoff brief stopped");
    expect(host.textContent).not.toContain("This chat continues without a brief.");
  });

  it("hides Retry on an older seed, while a Retry is queued, and in a read-only view", async () => {
    await render({ turn: seed("error"), latest: false, onRetry: vi.fn() });
    expect(button("Retry the handoff brief")).toBeUndefined();
    await render({ turn: seed("error"), retryPending: true, onRetry: vi.fn() });
    expect(button("Retry the handoff brief")).toBeUndefined();
    await render({ turn: seed("error") });
    expect(button("Retry the handoff brief")).toBeUndefined();
  });

  it("names a trashed source by the title frozen on the seed, never its ref", async () => {
    source.trashed = true;
    await render({ turn: seed("complete") });
    expect(host.querySelector("[data-source-link]")?.textContent).toBe(
      "Chapter 12 plan (in the trash)",
    );
    const untitled = seed("complete", {
      metadata: {
        kind: "derivation_seed",
        derivation: "handoff",
        sourceThreadId: "source",
        sourceRef: "c1",
        sourceTitle: null,
      },
    });
    await render({ turn: untitled });
    expect(host.querySelector("[data-source-link]")?.textContent).toBe(
      "the source chat (in the trash)",
    );
    expect(host.textContent).not.toContain("c1");
  });

  it("carries no live region: the global announcer speaks its changes", async () => {
    await render({ turn: seed("pending"), onStop: vi.fn() });
    expect(host.querySelector('[role="status"], [aria-live]')).toBeNull();
  });
});
