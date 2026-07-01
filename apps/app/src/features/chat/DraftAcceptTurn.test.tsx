/**
 * @vitest-environment jsdom
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { undoAcceptMutateAsync, undoRejectMutateAsync } = vi.hoisted(() => ({
  undoAcceptMutateAsync: vi.fn(),
  undoRejectMutateAsync: vi.fn(),
}));

vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useUndoDraftAccept: () => ({ mutateAsync: undoAcceptMutateAsync }),
  useUndoDraftReject: () => ({ mutateAsync: undoRejectMutateAsync }),
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (result, part, index) =>
        `${result}${part}${index < values.length ? String(values[index]) : ""}`,
      "",
    ),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// React 19 requires this flag when using react-dom/test-utils-style act() directly.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ChatContextNavigationProvider } from "./ChatContextNavigation";
import { DraftAcceptTurn } from "./DraftAcceptTurn";

describe("DraftAcceptTurn", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    undoAcceptMutateAsync.mockReset();
    undoRejectMutateAsync.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders accepted draft events as user-attributed undo affordances", async () => {
    undoAcceptMutateAsync.mockResolvedValue({ status: "reactivated", draftId: "draft-1" });

    renderDraftAcceptTurn();

    expect(container.textContent).toContain("Chapter 1");
    expect(button("Undo acceptance").disabled).toBe(false);
    await click(button("Undo acceptance"));

    expect(undoAcceptMutateAsync).toHaveBeenCalledWith({
      threadId: "thread-1",
      documentId: "doc-1",
      draftId: "draft-1",
    });
    expect(button("Undone").disabled).toBe(true);
  });

  function renderDraftAcceptTurn() {
    act(() => {
      root.render(
        <ChatContextNavigationProvider onOpenContextUri={null}>
          <DraftAcceptTurn
            turn={{
              ...turnWithBlocks([]),
              id: "turn-accept",
              role: "user",
              requestParams: {
                kind: "draft_accept",
                draftId: "draft-1",
                documentId: "doc-1",
                documentName: "Chapter 1",
              },
            }}
          />
        </ChatContextNavigationProvider>,
      );
    });
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
      await Promise.resolve();
    });
  }

  function button(name: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (!(found instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`);
    return found;
  }
});

function turnWithBlocks(blocks: Block[]): Turn {
  return {
    id: "turn-1",
    threadId: "thread-1",
    role: "assistant",
    status: "complete",
    finishReason: "end_turn",
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    usage: null,
    error: null,
    responseCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    blocks,
    siblingIds: [],
    responses: [],
  };
}
