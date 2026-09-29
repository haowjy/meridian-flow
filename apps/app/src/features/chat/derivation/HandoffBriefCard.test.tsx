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
  await act(async () => root.render(<HandoffBriefCard latest stopping={false} {...props} />));
}

const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );
const card = () => host.querySelector("[data-handoff-brief]");

describe("HandoffBriefCard", () => {
  it("generating while S is pending: says so, links the source, and Stop targets S", async () => {
    const onStop = vi.fn();
    await render({ turn: seed("pending"), onStop });
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

  it("a failed Stop says so on the card, and Stop is offered again", async () => {
    const onStop = vi.fn();
    await render({ turn: seed("pending"), stopFailed: true, onStop });
    expect(host.textContent).toContain("Couldn't stop the brief. Try again.");
    await act(async () => button("Stop the handoff brief")?.click());
    expect(onStop).toHaveBeenCalledWith("s");
  });

  it("says a refused Retry didn't run, even once a newer brief has replaced the card", async () => {
    await render({ turn: seed("error"), latest: false, retryRefused: true, onRetry: vi.fn() });
    expect(host.textContent).toContain(
      "Couldn't retry. Something else started in this chat first.",
    );
    expect(button("Retry the handoff brief")).toBeUndefined();
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

  it("failed: the seed's writer copy and Retry, which retries from this seed", async () => {
    const onRetry = vi.fn();
    const failed = seed("error", { error: "This handoff brief couldn't be generated. Try again." });
    await render({ turn: failed, onRetry });
    expect(card()?.getAttribute("aria-label")).toBe("Handoff brief unavailable");
    expect(host.textContent).toContain("This handoff brief couldn't be generated. Try again.");
    await act(async () => button("Retry the handoff brief")?.click());
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  it("interrupted: a crash cut the brief off; it says so and offers Retry", async () => {
    await render({
      turn: seed("error", {
        error: "This handoff brief couldn't be generated. Try again.",
        metadata: {
          kind: "derivation_seed",
          derivation: "handoff",
          sourceThreadId: "source",
          sourceTitle: "Chapter 12 plan",
          reason: "interrupted",
          phase: "recovery",
        },
      }),
      onRetry: vi.fn(),
    });
    expect(card()?.getAttribute("aria-label")).toBe("Handoff brief interrupted");
    expect(button("Retry the handoff brief")).toBeDefined();
  });

  it("Retry waits while the chat replies, and works once the reply ends", async () => {
    const onRetry = vi.fn();
    const failed = seed("error", { error: "This handoff brief couldn't be generated. Try again." });
    await render({ turn: failed, destinationBusy: true, onRetry });
    const retry = button("Retry the handoff brief");
    // aria-disabled, not disabled: keyboard focus can still land on it after Stop.
    expect(retry?.getAttribute("aria-disabled")).toBe("true");
    expect(retry?.hasAttribute("disabled")).toBe(false);
    expect(host.textContent).toContain("You can retry when the reply finishes.");
    const waitNote = document.getElementById(retry?.getAttribute("aria-describedby") ?? "");
    expect(waitNote?.textContent).toBe("You can retry when the reply finishes.");
    await act(async () => retry?.click());
    expect(onRetry).not.toHaveBeenCalled();

    await render({ turn: failed, destinationBusy: false, onRetry });
    expect(button("Retry the handoff brief")?.hasAttribute("aria-disabled")).toBe(false);
    expect(host.textContent).not.toContain("You can retry when the reply finishes.");
    await act(async () => button("Retry the handoff brief")?.click());
    expect(onRetry).toHaveBeenCalledWith(failed);
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

  it("hides Retry on an older seed (a Retry's new card replaced it) and in a read-only view", async () => {
    await render({ turn: seed("error"), latest: false, onRetry: vi.fn() });
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
