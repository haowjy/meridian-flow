// @vitest-environment jsdom
/** Exact chat-link landing through real reveal routing and retained transcript folds. */
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
import { ReviewChangeRow } from "./ReviewChangeRow";
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

describe("change conversation landing", () => {
  it.each([
    "open",
    "closed",
    "missing",
  ] as const)("lands the change's chat link on its %s tool target without expanding a fold", async (target) => {
    const props = rowProps({
      change: change({
        attribution: {
          kind: "chats",
          chats: [
            {
              threadId: "t-9",
              title: "Line edit",
              turnId: "turn-4",
              toolCallId: target === "missing" ? "call-9" : "call-2",
            },
          ],
        },
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
