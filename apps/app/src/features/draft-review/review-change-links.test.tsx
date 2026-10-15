// @vitest-environment jsdom
/** A change's chat link opens the chat at the write that made it, not at the chat's usual position. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import {
  abandonConversationReveal,
  peekConversationReveal,
} from "@/test-support/conversation-reveal";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ChangeAuthor } from "./ReviewChangeParts";
import type { BylineSource } from "./review-model";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(abandonConversationReveal);

async function clickLink(edit: BylineSource) {
  const byline = [
    {
      kind: "thread" as const,
      threadId: edit.threadId,
      turnId: edit.turnId,
      ...(edit.toolCallId ? { toolCallId: edit.toolCallId } : {}),
    },
  ];
  const openThread = vi.fn();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  await withReactRoot(
    <I18nProvider i18n={i18n}>
      <TooltipProvider>
        <ChatThreadNavigationProvider onOpenThread={openThread}>
          <ChangeAuthor change={{ byline, edits: [edit] }} overflow="hide" />
        </ChatThreadNavigationProvider>
      </TooltipProvider>
    </I18nProvider>,
    async () => {
      const link = document.querySelector<HTMLButtonElement>("button[title]");
      await act(async () => link?.click());
    },
  );
}

describe("change chat link", () => {
  it("reveals the turn and tool call that wrote the change", async () => {
    await clickLink({
      threadId: "t-9",
      turnId: "turn-4",
      toolCallId: "call-2",
      title: "Line edit",
      owner: {
        threadId: "t-9",
        title: "Line edit",
        reveal: { threadId: "t-9", turnId: "turn-4", toolCallId: "call-2" },
      },
    });
    expect(peekConversationReveal()).toMatchObject({
      kind: "turn",
      threadId: "t-9",
      turnId: "turn-4",
      toolCallId: "call-2",
    });
  });
});
