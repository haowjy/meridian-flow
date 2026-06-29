/**
 * @vitest-environment jsdom
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { documentMutateAsync, turnMutateAsync, liveLineageDocuments } = vi.hoisted(() => ({
  documentMutateAsync: vi.fn(),
  turnMutateAsync: vi.fn(),
  liveLineageDocuments: {
    current: null as Array<{ documentId: string; uri: string; path: string }> | null,
  },
}));

vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseDocumentMutation: () => ({ mutateAsync: documentMutateAsync }),
  useReverseTurnMutation: () => ({ mutateAsync: turnMutateAsync }),
}));

vi.mock("@/client/query/useTurnLiveLineage", () => ({
  useTurnLiveLineage: (
    _threadId: string | null,
    _turnId: string | null,
    options?: { enabled?: boolean },
  ) => ({
    data: options?.enabled === false ? null : liveLineageDocuments.current,
    documents: options?.enabled === false ? null : liveLineageDocuments.current,
    status: options?.enabled === false ? "disabled" : "ready",
  }),
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

import { AssistantTurn } from "./AssistantTurn";
import { ChatContextNavigationProvider } from "./ChatContextNavigation";
import { DraftAcceptTurn } from "./DraftAcceptTurn";
import { TurnChangeFooter } from "./TurnChangeFooter";

describe("TurnChangeFooter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    documentMutateAsync.mockReset();
    turnMutateAsync.mockReset();
    liveLineageDocuments.current = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders server-provided live-lineage documents", () => {
    renderFooter(documentsForPaths(["/chapter-1.mdx"]));

    expect(button("📝 1 document changed")).toBeDefined();
  });

  it("does not render without live-lineage documents", () => {
    renderFooter([]);

    expect(container.textContent).toBe("");
  });

  it("flips a document Undo action to Redo after the reverse succeeds", async () => {
    documentMutateAsync.mockResolvedValue({
      status: "reversed",
      documents: [{ uri: "manuscript://chapter-1.mdx", status: "reversed" }],
    });
    renderFooter(documentsForPaths(["/chapter-1.mdx"]));
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

  it("exercises a document undo-redo-undo cycle with normalized reversal outcomes", async () => {
    documentMutateAsync
      .mockResolvedValueOnce({
        status: "reversed",
        documents: [{ uri: "manuscript://chapter-1.mdx", status: "reversed" }],
      })
      .mockResolvedValueOnce({
        status: "reconciled",
        documents: [{ uri: "manuscript://chapter-1.mdx", status: "reconciled" }],
      })
      .mockResolvedValueOnce({
        status: "reversed",
        documents: [{ uri: "manuscript://chapter-1.mdx", status: "reversed" }],
      });
    renderFooter(documentsForPaths(["/chapter-1.mdx"]));
    expandFooter();

    await click(button("Undo"));
    await click(button("Redo"));
    await click(button("Undo"));

    expect(documentMutateAsync).toHaveBeenNthCalledWith(1, {
      turnId: "turn-1",
      uri: "manuscript://chapter-1.mdx",
      direction: "undo",
    });
    expect(documentMutateAsync).toHaveBeenNthCalledWith(2, {
      turnId: "turn-1",
      uri: "manuscript://chapter-1.mdx",
      direction: "redo",
    });
    expect(documentMutateAsync).toHaveBeenNthCalledWith(3, {
      turnId: "turn-1",
      uri: "manuscript://chapter-1.mdx",
      direction: "undo",
    });
    expect(button("Redo").disabled).toBe(false);
  });

  it("treats nothing_to_undo as already undone and offers Redo", async () => {
    documentMutateAsync.mockResolvedValue({
      status: "nothing_to_undo",
      documents: [{ uri: "kb://world/rules.md", status: "nothing_to_undo" }],
    });
    renderFooter(documentsForPaths(["kb://world/rules.md"]));
    expandFooter();

    await click(button("Undo"));

    expect(button("Redo").disabled).toBe(false);
  });

  it("disables the row and explains when an undo has expired", async () => {
    documentMutateAsync.mockResolvedValue({
      status: "expired",
      documents: [{ uri: "work://work-1/notes/beat.md", status: "expired" }],
    });
    renderFooter(documentsForPaths(["work://work-1/notes/beat.md"]));
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
    renderFooter(documentsForPaths(["/chapter-1.mdx", "kb://world/rules.md"]));
    expandFooter();

    await click(button("Undo all"));

    expect(turnMutateAsync).toHaveBeenCalledWith({ turnId: "turn-1", direction: "undo" });
    expect(button("Redo all").disabled).toBe(false);
    expect(container.textContent).toContain("(all undone)");
  });

  it("offers Redo all when the only actionable rows are reversed", async () => {
    turnMutateAsync.mockResolvedValue({
      status: "partial",
      documents: [
        { uri: "manuscript://expired.mdx", status: "expired" },
        { uri: "manuscript://chapter-1.mdx", status: "reversed" },
      ],
    });
    renderFooter(documentsForPaths(["/expired.mdx", "/chapter-1.mdx"]));
    expandFooter();

    await click(button("Undo all"));

    expect(button("Redo all").disabled).toBe(false);
    expect(container.textContent).toContain("Can no longer be undone");
    expect(container.textContent).toContain("(all undone)");
  });

  it("disables the turn action when no actionable rows remain", async () => {
    turnMutateAsync.mockResolvedValue({
      status: "expired",
      documents: [{ uri: "manuscript://expired.mdx", status: "expired" }],
    });
    renderFooter(documentsForPaths(["/expired.mdx"]));
    expandFooter();

    await click(button("Undo all"));

    expect(button("Undo all").disabled).toBe(true);
  });

  it("passes canonical document URIs to the optional chat context navigation callback", async () => {
    const opened: string[] = [];
    renderFooter(documentsForPaths(["work://work-1/notes/beat.md"]), (uri) => opened.push(uri));
    expandFooter();

    await click(button("beat.md"));

    expect(opened).toEqual(["work://work-1/notes/beat.md"]);
  });

  it("mounts the footer through AssistantTurn from accepted-draft live lineage", () => {
    liveLineageDocuments.current = documentsForPaths(["/chapter-1.mdx"]);

    renderAssistantTurn({ ...turnWithBlocks([]), status: "complete" });

    expect(container.textContent).toContain("1 document changed");
  });

  it("renders draft accept events as user-attributed undo affordances", async () => {
    turnMutateAsync.mockResolvedValue({
      status: "reversed",
      documents: [{ uri: "manuscript://chapter-1.mdx", status: "reversed" }],
    });
    liveLineageDocuments.current = documentsForPaths(["/chapter-1.mdx"]);

    renderDraftAcceptTurn();

    expect(container.textContent).toContain("You accepted this draft");
    expect(button("Undo").disabled).toBe(false);
    await click(button("Undo"));

    expect(turnMutateAsync).toHaveBeenCalledWith({ turnId: "turn-accept", direction: "undo" });
    expect(container.textContent).toContain("You undid your acceptance");
    expect(button("Redo").disabled).toBe(false);
  });

  it("keeps the footer hidden when AssistantTurn has no live lineage", () => {
    liveLineageDocuments.current = [];

    renderAssistantTurn({ ...turnWithBlocks([]), status: "complete" });

    expect(container.textContent).not.toContain("1 document changed");
  });

  it("keeps the footer hidden while AssistantTurn is live", () => {
    liveLineageDocuments.current = documentsForPaths(["/chapter-1.mdx"]);

    renderAssistantTurn({ ...turnWithBlocks([]), status: "streaming" });

    expect(container.textContent).not.toContain("1 document changed");
  });

  function renderFooter(
    documents: Array<{ documentId: string; uri: string; path: string }>,
    onOpenContextUri?: (uri: string) => void,
  ) {
    act(() => {
      root.render(
        <ChatContextNavigationProvider onOpenContextUri={onOpenContextUri ?? null}>
          <TurnChangeFooter threadId="thread-1" turn={turnWithBlocks([])} documents={documents} />
        </ChatContextNavigationProvider>,
      );
    });
  }

  function renderAssistantTurn(turn: Turn) {
    act(() => {
      root.render(
        <ChatContextNavigationProvider onOpenContextUri={null}>
          <AssistantTurn turn={turn} />
        </ChatContextNavigationProvider>,
      );
    });
  }

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
              },
            }}
          />
        </ChatContextNavigationProvider>,
      );
    });
  }

  function expandFooter() {
    act(() => {
      button(/documents? changed/).click();
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

function documentsForPaths(
  paths: string[],
): Array<{ documentId: string; uri: string; path: string }> {
  return paths.map((path, index) => {
    const uri = path.includes("://") ? path : `manuscript://${path.replace(/^\/+/, "")}`;
    return {
      documentId: `doc-${index + 1}`,
      uri,
      path: displayPath(uri, path),
    };
  });
}

function displayPath(uri: string, fallback: string): string {
  const path = uri.includes("://") ? uri.split("://")[1] : fallback;
  return `/${path.replace(/^\/+/, "")}`;
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
