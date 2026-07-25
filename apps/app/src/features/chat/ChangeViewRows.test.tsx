// @vitest-environment jsdom
/** Receipt rows expose concise durable excerpts and exact editor navigation. */
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
vi.mock("@/core/editor/change-mark-labels", () => ({
  changeKindLabel: (kind: string) => `${kind} label`,
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

  it("renders clamped excerpts without row chrome or copy controls", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChangeViewRows documentId="document-1" changes={[change]} navigateToChange={vi.fn()} />,
      );
    });

    expect(container.textContent).toContain("Before text.");
    expect(container.textContent).toContain("After text.");
    expect(container.textContent).not.toContain("Copy");
    expect(container.querySelector('[data-change-excerpt="before"]')?.className).toContain(
      "line-clamp-3",
    );
    expect(container.querySelector('[data-change-excerpt="before"]')?.className).not.toContain(
      "overflow-y-auto",
    );
    expect(container.querySelector('[data-change-view-row="modify"]')?.className).not.toContain(
      "rounded",
    );
    await act(async () => root.unmount());
  });

  it("keeps intentionally blank Before and After sides visible", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChangeViewRows
          documentId="document-1"
          changes={[{ ...change, beforeText: "block-1|", afterTextAtReceipt: "block-1|" }]}
          navigateToChange={vi.fn()}
        />,
      );
    });

    expect(container.querySelectorAll("[data-change-excerpt]")).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it("brings an explicit reveal into view without animated emphasis", async () => {
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
    expect(row?.className).not.toContain("meridian-trail-row-emphasized");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(peekConversationReveal()).toBeNull();
    await act(async () => root.unmount());
  });

  it("navigates the exact selected change", async () => {
    const navigateToChange = vi.fn(async () => ({ kind: "shown" as const }));
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChangeViewRows
          documentId="document-1"
          changes={[change]}
          navigateToChange={navigateToChange}
        />,
      );
    });

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(navigateToChange).toHaveBeenCalledWith("document-1", change);
    await act(async () => root.unmount());
  });
});
