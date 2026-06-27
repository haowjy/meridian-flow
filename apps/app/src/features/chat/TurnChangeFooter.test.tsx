/**
 * @vitest-environment jsdom
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { documentMutateAsync, turnMutateAsync } = vi.hoisted(() => ({
  documentMutateAsync: vi.fn(),
  turnMutateAsync: vi.fn(),
}));

vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseDocumentMutation: () => ({ mutateAsync: documentMutateAsync }),
  useReverseTurnMutation: () => ({ mutateAsync: turnMutateAsync }),
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (result, part, index) =>
        `${result}${part}${index < values.length ? String(values[index]) : ""}`,
      "",
    ),
}));

// React 19 requires this flag when using react-dom/test-utils-style act() directly.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ChatContextNavigationProvider } from "./ChatContextNavigation";
import { TurnChangeFooter } from "./TurnChangeFooter";

describe("TurnChangeFooter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    documentMutateAsync.mockReset();
    turnMutateAsync.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("counts only write/edit calls with successful tool results", () => {
    renderFooter(
      turnWithBlocks([
        toolUseBlock(1, "write", "/chapter-1.mdx", "call-1"),
        toolResultBlock(2, "call-1", "success"),
        toolUseBlock(3, "edit", "/missing.mdx", "call-2"),
        toolResultBlock(4, "call-2", "not_found"),
      ]),
    );

    expect(button("📝 1 file changed")).toBeDefined();
    expect(container.textContent).not.toContain("missing.mdx");
  });

  it("does not render when every write/edit tool result failed", () => {
    renderFooter(
      turnWithBlocks([
        toolUseBlock(1, "edit", "/missing.mdx", "call-1"),
        toolResultBlock(2, "call-1", "invalid_write"),
      ]),
    );

    expect(container.textContent).toBe("");
  });

  it("flips a document Undo action to Redo after the reverse succeeds", async () => {
    documentMutateAsync.mockResolvedValue({ status: "reversed" });
    renderFooter(turnWithPaths(["/chapter-1.mdx"]));
    expandFooter();

    expect(button("Undo").disabled).toBe(false);
    await click(button("Undo"));

    expect(documentMutateAsync).toHaveBeenCalledWith({
      turnId: "turn-1",
      uri: "manuscript://chapter-1.mdx",
      direction: "undo",
    });
    expect(button("Redo").disabled).toBe(false);
  });

  it("treats nothing_to_undo as already undone and offers Redo", async () => {
    documentMutateAsync.mockResolvedValue({ status: "nothing_to_undo" });
    renderFooter(turnWithPaths(["kb://world/rules.md"]));
    expandFooter();

    await click(button("Undo"));

    expect(button("Redo").disabled).toBe(false);
  });

  it("disables the row and explains when an undo has expired", async () => {
    documentMutateAsync.mockResolvedValue({ status: "expired" });
    renderFooter(turnWithPaths(["work://work-1/notes/beat.md"]));
    expandFooter();

    await click(button("Undo"));

    expect(text("Can no longer be undone")).not.toBeNull();
    expect(button("Undo").disabled).toBe(true);
  });

  it("applies Undo all results and flips the summary action to Redo all", async () => {
    turnMutateAsync.mockResolvedValue({
      status: "reversed",
      documents: [
        { uri: "manuscript://chapter-1.mdx", status: "reversed" },
        { uri: "kb://world/rules.md", status: "reversed" },
      ],
    });
    renderFooter(turnWithPaths(["/chapter-1.mdx", "kb://world/rules.md"]));
    expandFooter();

    await click(button("Undo all"));

    expect(turnMutateAsync).toHaveBeenCalledWith({ turnId: "turn-1", direction: "undo" });
    expect(button("Redo all").disabled).toBe(false);
    expect(container.textContent).toContain("(all undone)");
  });

  it("passes canonical document URIs to the optional chat context navigation callback", async () => {
    const opened: string[] = [];
    renderFooter(turnWithPaths(["work://work-1/notes/beat.md"]), (uri) => opened.push(uri));
    expandFooter();

    await click(button("beat.md"));

    expect(opened).toEqual(["work://work-1/notes/beat.md"]);
  });

  function renderFooter(turn: Turn, onOpenContextUri?: (uri: string) => void) {
    act(() => {
      root.render(
        <ChatContextNavigationProvider onOpenContextUri={onOpenContextUri ?? null}>
          <TurnChangeFooter threadId="thread-1" turn={turn} />
        </ChatContextNavigationProvider>,
      );
    });
  }

  function expandFooter() {
    act(() => {
      button(/files? changed/).click();
    });
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
      await Promise.resolve();
    });
  }

  function button(name: string | RegExp): HTMLButtonElement {
    const matcher =
      typeof name === "string"
        ? (value: string) => value === name
        : (value: string) => name.test(value);
    const found = Array.from(container.querySelectorAll("button")).find((candidate) =>
      matcher(candidate.textContent?.trim() ?? ""),
    );
    if (!(found instanceof HTMLButtonElement)) throw new Error(`Button not found: ${String(name)}`);
    return found;
  }

  function text(value: string): Node | null {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent?.includes(value)) return node;
      node = walker.nextNode();
    }
    return null;
  }
});

function turnWithPaths(paths: string[]): Turn {
  return turnWithBlocks(
    paths.flatMap((path, index) => {
      const sequence = index * 2 + 1;
      const toolCallId = `call-${index + 1}`;
      return [
        toolUseBlock(sequence, "write", path, toolCallId),
        toolResultBlock(sequence + 1, toolCallId, "success"),
      ];
    }),
  );
}

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

function toolUseBlock(
  sequence: number,
  toolName: string,
  path: string,
  toolCallId = `call-${sequence}`,
): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    responseId: null,
    blockType: "tool_use",
    sequence,
    content: { toolCallId, toolName, input: { path } },
    status: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function toolResultBlock(
  sequence: number,
  toolCallId: string,
  status: "success" | "not_found" | "invalid_write",
): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    responseId: null,
    blockType: "tool_result",
    sequence,
    content: {
      toolCallId,
      toolName: "write",
      output: { status, isError: status !== "success", text: `status: ${status}` },
      isError: status !== "success",
    },
    status: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
