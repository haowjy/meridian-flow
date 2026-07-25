// @vitest-environment jsdom
/** Explicit conversation reveals temporarily expose otherwise-suppressed generative changes. */

import type { TrailChangeV1 as TrailChange } from "@meridian/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeConversationReveal,
  peekConversationReveal,
  requestConversationReveal,
} from "./conversation-reveal";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({ peek: () => null }),
}));

const { ChangeViewRows } = await import("./ChangeViewRows");

const generativeInsertion: TrailChange = {
  changeId: "change-1",
  ordinal: 0,
  documentId: "document-1",
  pushId: "push-1",
  receiptId: "receipt-1",
  kind: "insert",
  beforeBlockId: null,
  afterBlockId: "block-1",
  beforeText: null,
  afterTextAtReceipt: "Agent text.",
  navigation: { kind: "unavailable", reason: "test" },
  writerImpact: null,
  reversible: false,
};

describe("ChangeViewRows conversation reveal", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    const pending = peekConversationReveal();
    if (pending) completeConversationReveal(pending);
    document.body.replaceChildren();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("mounts, emphasizes, and completes an explicit reveal for a generative insertion", async () => {
    const reveal = { threadId: "thread-1", turnId: "turn-1", changeId: "change-1" };
    requestConversationReveal(reveal);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ChangeViewRows
          threadId="thread-1"
          trailId="trail-1"
          documentId="document-1"
          changes={[generativeInsertion]}
          navigateToChange={vi.fn()}
          reveal={reveal}
        />,
      );
    });

    const row = container.querySelector('[data-change-view-row="insert"]');
    expect(row).not.toBeNull();
    expect(row?.className).toContain("meridian-trail-row-emphasized");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledOnce();
    expect(peekConversationReveal()).toBeNull();

    await act(async () => root.unmount());
  });
});
