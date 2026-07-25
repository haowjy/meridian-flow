// @vitest-environment jsdom
/** Receipt rows expose durable before/after excerpts and exact reveal targeting. */
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
vi.mock("@/core/editor/change-mark-labels", () => ({
  changeKindLabel: (kind: string) => `${kind} label`,
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
const { ChangeViewRows } = await import("./ChangeViewRows");

const change: TrailChange = {
  changeId: "change-1",
  ordinal: 0,
  documentId: "document-1",
  pushId: "push-1",
  receiptId: "receipt-1",
  kind: "modify",
  beforeBlockId: "block-1",
  afterBlockId: "block-1",
  beforeText: "block-1|Before text.",
  afterTextAtReceipt: "block-1|After text.",
  navigation: { kind: "unavailable", reason: "test" },
  reversible: false,
};

describe("ChangeViewRows", () => {
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
  });

  it("renders before and after excerpts and copies the before excerpt", async () => {
    const copyText = vi.fn(async () => {});
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChangeViewRows
          documentId="document-1"
          changes={[change]}
          navigateToChange={vi.fn()}
          copyText={copyText}
        />,
      );
    });

    expect(container.textContent).toContain("Before text.");
    expect(container.textContent).toContain("After text.");
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy",
    );
    await act(async () => copy?.click());
    expect(copyText).toHaveBeenCalledWith("Before text.");
    await act(async () => root.unmount());
  });

  it("keeps intentionally blank Before and After sides visible", async () => {
    const copyText = vi.fn(async () => {});
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChangeViewRows
          documentId="document-1"
          changes={[{ ...change, beforeText: "block-1|", afterTextAtReceipt: "block-1|" }]}
          navigateToChange={vi.fn()}
          copyText={copyText}
        />,
      );
    });

    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");
    expect(container.querySelectorAll(".whitespace-pre-wrap")).toHaveLength(2);
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy",
    );
    await act(async () => copy?.click());
    expect(copyText).toHaveBeenCalledWith("");
    await act(async () => root.unmount());
  });

  it("emphasizes and completes an explicit reveal", async () => {
    const reveal = { threadId: "thread-1", turnId: "turn-1", changeId: "change-1" };
    requestConversationReveal(reveal);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChangeViewRows
          documentId="document-1"
          changes={[change]}
          navigateToChange={vi.fn()}
          reveal={reveal}
        />,
      );
    });

    const row = container.querySelector('[data-change-view-row="modify"]');
    expect(row?.className).toContain("meridian-trail-row-emphasized");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledOnce();
    expect(peekConversationReveal()).toBeNull();
    await act(async () => root.unmount());
  });
});
