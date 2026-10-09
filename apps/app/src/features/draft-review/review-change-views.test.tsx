// @vitest-environment jsdom
/** Change controls, refusal visibility and real chat-link routing through retained process folds. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, useRef } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import { useConversationRevealRouting } from "@/features/chat/conversation-reveal";
import { ProcessDisclosure } from "@/features/chat/ProcessDisclosure";
import { block } from "@/features/chat/report-test-fixtures";
import { ToolRow } from "@/features/chat/ToolRow";
import { useTurnRevealLanding } from "@/features/chat/useTurnRevealLanding";
import {
  abandonConversationReveal,
  peekConversationReveal,
} from "@/test-support/conversation-reveal";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ChangeChat } from "./change-attribution";
import { ReviewChangeBar } from "./ReviewChangeBar";
import { ReviewChangeRow } from "./ReviewChangeRow";
import { ReviewStepper } from "./ReviewStepper";
import { ReviewToast } from "./ReviewToast";
import type { ReviewChange } from "./review-changes";

// jsdom lacks CSS.escape. These fixture IDs need no escaping.
const priorCss = globalThis.CSS;
beforeAll(() => {
  vi.stubGlobal("CSS", { ...priorCss, escape: (value: string) => value });
});
afterAll(() => vi.unstubAllGlobals());

function change(overrides: Partial<ReviewChange> = {}): ReviewChange {
  return {
    classId: "c1",
    operations: [],
    operationIds: ["1"],
    anchorOperationId: "1",
    markKeys: ["1"],
    actionable: true,
    tone: "ai",
    includesWriterEdits: false,
    merged: false,
    change: { removed: "his", added: "one withered" },
    attribution: { kind: "ai" },
    threadIds: [],
    ...overrides,
  };
}

/** A change written by chats, latest first; each is a link to its own turn. */
function chats(
  ...written: Partial<ChangeChat>[]
): Extract<ReviewChange["attribution"], { kind: "chats" }> {
  const [first, ...rest] = written.map((chat) => ({
    threadId: "t-1",
    title: null,
    turnId: null,
    toolCallId: null,
    ...chat,
  }));
  return { kind: "chats", chats: [first, ...rest] };
}

function render(node: React.ReactNode, run: () => Promise<void>, openThread = vi.fn()) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <TooltipProvider>
        <ChatThreadNavigationProvider onOpenThread={openThread}>
          {node}
        </ChatThreadNavigationProvider>
      </TooltipProvider>
    </I18nProvider>,
    run,
  );
}

const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === name,
  );

const rowProps = (overrides: Partial<React.ComponentProps<typeof ReviewChangeRow>> = {}) => ({
  change: change(),
  focused: false,
  disabled: false,
  canApply: true,
  failure: null,
  onFocus: vi.fn(),
  onApply: vi.fn(),
  onDiscard: vi.fn(),
  ...overrides,
});

describe("ReviewChangeRow", () => {
  it("focuses the change on a click, and Apply or Discard act without also focusing", async () => {
    const props = rowProps();
    await render(
      <ul>
        <ReviewChangeRow {...props} />
      </ul>,
      async () => {
        await act(async () => document.querySelector<HTMLElement>("li")?.click());
        expect(props.onFocus).toHaveBeenCalledTimes(1);
        await act(async () => button("Apply")?.click());
        await act(async () => button("Discard")?.click());
        expect(props.onApply).toHaveBeenCalledTimes(1);
        expect(props.onDiscard).toHaveBeenCalledTimes(1);
        expect(props.onFocus).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("is reachable from the keyboard: the excerpt is a button", async () => {
    const props = rowProps();
    await render(
      <ul>
        <ReviewChangeRow {...props} focused />
      </ul>,
      async () => {
        const excerpt = document.querySelector<HTMLButtonElement>("button[aria-current='true']");
        expect(excerpt).not.toBeNull();
        await act(async () => excerpt?.click());
        expect(props.onFocus).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("disables both commands while one is in flight, and hides Apply for a new document", async () => {
    await render(
      <ul>
        <ReviewChangeRow {...rowProps({ disabled: true })} />
      </ul>,
      async () => {
        expect(button("Apply")?.disabled).toBe(true);
        expect(button("Discard")?.disabled).toBe(true);
      },
    );
    await render(
      <ul>
        <ReviewChangeRow {...rowProps({ canApply: false })} />
      </ul>,
      async () => {
        expect(button("Apply")).toBeUndefined();
      },
    );
  });

  it.each([
    "open",
    "closed",
    "missing",
  ] as const)("lands the change's chat link on its %s tool target without expanding a fold", async (target) => {
    const props = rowProps({
      change: change({
        attribution: chats({
          threadId: "t-9",
          title: "Line edit",
          turnId: "turn-4",
          toolCallId: target === "missing" ? "call-9" : "call-2",
        }),
      }),
    });
    const scrollToIndex = vi.fn();
    const openThread = vi.fn();
    try {
      await render(
        <>
          <ul>
            <ReviewChangeRow {...props} />
          </ul>
          <RevealTranscript scrollToIndex={scrollToIndex} openThread={openThread} />
        </>,
        async () => {
          window.matchMedia = () => ({ matches: true }) as MediaQueryList;
          const fold = document.querySelector<HTMLButtonElement>("[data-tool-call-ids]");
          if (!fold) throw new Error("missing process fold");
          // A previously opened, now closed fold retains hidden ToolRows.
          await act(async () => fold.click());
          if (target !== "open") await act(async () => fold.click());
          const exact = document.querySelector<HTMLElement>('[data-tool-call-id="call-2"]');
          if (!exact) throw new Error("missing tool row");
          const foldScroll = vi.fn();
          const rowScroll = vi.fn();
          fold.scrollIntoView = foldScroll;
          exact.scrollIntoView = rowScroll;
          const link = Array.from(document.querySelectorAll("button")).find((b) =>
            b.textContent?.includes("Line edit"),
          );
          await act(async () => link?.click());
          expect(openThread).toHaveBeenCalledWith("t-9");
          expect(scrollToIndex).toHaveBeenCalledWith(0);
          if (target !== "missing") {
            await vi.waitFor(() =>
              expect(target === "open" ? rowScroll : foldScroll).toHaveBeenCalled(),
            );
          }
          if (target === "missing") {
            await act(
              async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
            );
            expect(foldScroll).not.toHaveBeenCalled();
          }
          expect(target === "open" ? foldScroll : rowScroll).not.toHaveBeenCalled();
          expect(fold.getAttribute("aria-expanded")).toBe(String(target === "open"));
          expect(peekConversationReveal()).toBeNull();
          expect(props.onFocus).not.toHaveBeenCalled();
        },
      );
    } finally {
      abandonConversationReveal();
    }
  });

  it("names every chat of a shared change, each a link to its own turn", async () => {
    const props = rowProps({
      change: change({
        attribution: chats(
          { threadId: "t-1", title: "Pacing pass", turnId: "turn-9", toolCallId: "call-4" },
          { threadId: "t-2", title: "Lore pass", turnId: "turn-3", toolCallId: null },
        ),
      }),
    });
    const openThread = vi.fn();
    await render(
      <ul>
        <ReviewChangeRow {...props} />
      </ul>,
      async () => {
        const links = Array.from(document.querySelectorAll("button")).filter((b) =>
          /Pacing pass|Lore pass/.test(b.textContent ?? ""),
        );
        expect(links.map((link) => link.textContent)).toEqual(["Pacing pass", "Lore pass"]);
        expect(document.querySelector("li")?.textContent).toContain("Pacing pass and Lore pass");
        await act(async () => links[1].click());
        expect(peekConversationReveal()).toEqual({
          kind: "turn",
          threadId: "t-2",
          turnId: "turn-3",
        });
        abandonConversationReveal();
        await act(async () => links[0].click());
        expect(peekConversationReveal()).toEqual({
          kind: "turn",
          threadId: "t-1",
          turnId: "turn-9",
          toolCallId: "call-4",
        });
        abandonConversationReveal();
        expect(openThread).not.toHaveBeenCalled();
        expect(props.onFocus).not.toHaveBeenCalled();
      },
      openThread,
    );
  });

  it("shows why a command did not land, on the row", async () => {
    await render(
      <ul>
        <ReviewChangeRow
          {...rowProps({ failure: { phase: "failed", mode: "apply", code: "offline" } })}
        />
      </ul>,
      async () => {
        expect(document.querySelector("li")?.textContent).toContain(
          "Couldn't apply. Check your connection and try again.",
        );
      },
    );
  });
});

const unattributed = (overrides: Partial<ReviewChange> = {}) =>
  change({
    classId: "unattributed:h",
    operationIds: [],
    anchorOperationId: "unattributed:h",
    markKeys: ["unattributed:h"],
    actionable: false,
    tone: "unattributed",
    attribution: { kind: "unattributed" },
    change: { removed: "Alpha", added: null },
    ...overrides,
  });

describe("a change with no per-change commands", () => {
  it("a row names no author, shows what was removed, and has no Apply or Discard", async () => {
    await render(
      <ul>
        <ReviewChangeRow {...rowProps({ change: unattributed() })} />
      </ul>,
      async () => {
        const row = document.querySelector("[data-review-change-row]");
        expect(row?.textContent).toContain("Alpha");
        expect(row?.textContent).toContain("Unattributed");
        expect(button("Discard")).toBeUndefined();
        expect(button("Apply")).toBeUndefined();
        expect(document.querySelector("[data-tone=unattributed]")).not.toBeNull();
      },
    );
  });

  it("a row of a class the server flags has no commands either, whoever wrote it", async () => {
    await render(
      <ul>
        <ReviewChangeRow {...rowProps({ change: change({ actionable: false }) })} />
      </ul>,
      async () => {
        expect(document.querySelector("[data-review-change-row]")?.textContent).toContain("AI");
        expect(button("Discard")).toBeUndefined();
        expect(button("Apply")).toBeUndefined();
      },
    );
  });

  it("the bar says Apply draft or Discard draft handles it, with no buttons", async () => {
    await render(
      <ReviewChangeBar
        change={unattributed()}
        disabled={false}
        canApply
        failure={null}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />,
      async () => {
        expect(document.body.textContent).toContain("Unattributed");
        expect(document.body.textContent).toContain("Apply draft or Discard draft handles this.");
        expect(button("Discard")).toBeUndefined();
        expect(button("Apply")).toBeUndefined();
      },
    );
  });
});

describe("ReviewChangeBar", () => {
  const barProps = (overrides: Partial<React.ComponentProps<typeof ReviewChangeBar>> = {}) => ({
    change: change(),
    disabled: false,
    canApply: true,
    failure: null,
    onApply: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  });

  it("hides Apply for a new document, disables while in flight, and shows each refusal on the bar", async () => {
    await render(<ReviewChangeBar {...barProps({ canApply: false })} />, async () => {
      expect(button("Apply")).toBeUndefined();
    });
    await render(<ReviewChangeBar {...barProps({ disabled: true })} />, async () => {
      expect(button("Apply")?.disabled).toBe(true);
    });
    const messages = [
      ["apply", "stale", "This change was updated. Check it and apply again."],
      ["apply", "offline", "Couldn't apply. Check your connection and try again."],
      ["discard", "stale", "This change was updated. Check it and discard again."],
      ["discard", "offline", "Couldn't discard. Check your connection and try again."],
      ["apply", "server-error", "Couldn't apply this change. Try again."],
      ["discard", "server-error", "Couldn't discard this change. Try again."],
      [
        "apply",
        "unknown",
        "Couldn't confirm whether this applied. Check what is left before you try again.",
      ],
      [
        "discard",
        "unknown",
        "Couldn't confirm whether this was discarded. Check what is left before you try again.",
      ],
    ] as const;
    for (const [mode, code, text] of messages) {
      await render(
        <ReviewChangeBar {...barProps({ failure: { phase: "failed", mode, code } })} />,
        async () => {
          expect(document.body.textContent).toContain(text);
          // Only a lost request tells the writer to check their connection.
          if (code === "server-error")
            expect(document.body.textContent).not.toContain("connection");
        },
      );
    }
  });

  it("says a server refusal in the change's own words, followed by the server's reason", async () => {
    await render(
      <ReviewChangeBar
        {...barProps({
          failure: {
            phase: "failed",
            mode: "apply",
            code: "refused",
            serverCode: "quota_exceeded",
            serverReason: "This Work is archived and read-only.",
          },
        })}
      />,
      async () => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Couldn't apply this change. This Work is archived and read-only.");
        expect(text).not.toContain("connection");
      },
    );
    await render(
      <ReviewChangeBar
        {...barProps({ failure: { phase: "failed", mode: "discard", code: "refused" } })}
      />,
      async () => {
        expect(document.body.textContent).toContain("Couldn't discard this change.");
        expect(document.body.textContent).not.toContain("Try again");
      },
    );
  });
});

describe("ReviewStepper", () => {
  it("steps both ways with named buttons, and reads the position", async () => {
    const onStep = vi.fn();
    await render(
      <ReviewStepper count={6} focusedIndex={1} disabled={false} onStep={onStep} />,
      async () => {
        expect(document.body.textContent).toContain("2 of 6");
        await act(async () => button("Next change")?.click());
        await act(async () => button("Previous change")?.click());
        expect(onStep.mock.calls).toEqual([[1], [-1]]);
      },
    );
  });
});

describe("ReviewToast", () => {
  it("says what happened, offers no Undo, and dismisses itself", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    try {
      await render(
        <ReviewToast toast={{ id: 3, code: "applied", tone: "info" }} onDismiss={onDismiss} />,
        async () => {
          expect(document.querySelector("[role=status]")?.textContent).toBe("Applied");
          expect(document.querySelector("button")).toBeNull();
          await act(async () => {
            vi.advanceTimersByTime(4000);
          });
          expect(onDismiss).toHaveBeenCalledWith(3);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function RevealTranscript({
  scrollToIndex,
  openThread,
}: {
  scrollToIndex: (index: number) => void;
  openThread: (threadId: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useConversationRevealRouting(openThread);
  useTurnRevealLanding({
    threadId: "t-9",
    turns: [{ id: "turn-4" }],
    historySettled: true,
    viewportRef,
    scrollToIndex,
  });
  return (
    <div
      ref={(node) => {
        viewportRef.current = node;
        if (node) Object.defineProperty(node, "clientHeight", { value: 400 });
      }}
    >
      <div
        data-turn-id="turn-4"
        ref={(node) => {
          if (node) node.getBoundingClientRect = () => ({ height: 40 }) as DOMRect;
        }}
      >
        <ProcessDisclosure label="Thinking process" toolCallIds={["call-1", "call-2"]}>
          <ToolRow tool={revealTool("call-1")} />
          <ToolRow tool={revealTool("call-2")} />
        </ProcessDisclosure>
      </div>
    </div>
  );
}

function revealTool(toolCallId: string) {
  return {
    toolCallId,
    toolName: "read",
    input: { path: "chapter.md" },
    result: null,
    status: "complete" as const,
    isError: false,
    message: null,
    streamedOutput: null,
    metadata: null,
    keyBlock: block(toolCallId, 1, "tool_use", { toolCallId, toolName: "read" }),
  };
}
