/**
 * @vitest-environment jsdom
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { liveLineageDocuments } = vi.hoisted(() => ({
  liveLineageDocuments: {
    current: null as Array<{ documentId: string; uri: string; path: string }> | null,
  },
}));

vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseDocumentMutation: () => ({ mutateAsync: vi.fn() }),
  useReverseTurnMutation: () => ({ mutateAsync: vi.fn() }),
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

describe("AssistantTurn", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    liveLineageDocuments.current = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("mounts a change footer for completed turns with accepted-draft live lineage", () => {
    liveLineageDocuments.current = documentsForPaths(["/chapter-1.mdx"]);

    renderAssistantTurn({ ...turnWithBlocks([]), status: "complete" });

    expect(container.textContent).toContain("1 document changed");
  });

  it("keeps the change footer hidden when there is no live lineage", () => {
    liveLineageDocuments.current = [];

    renderAssistantTurn({ ...turnWithBlocks([]), status: "complete" });

    expect(container.textContent).not.toContain("1 document changed");
  });

  it("keeps the change footer hidden while the assistant turn is live", () => {
    liveLineageDocuments.current = documentsForPaths(["/chapter-1.mdx"]);

    renderAssistantTurn({ ...turnWithBlocks([]), status: "streaming" });

    expect(container.textContent).not.toContain("1 document changed");
  });

  function renderAssistantTurn(turn: Turn) {
    act(() => {
      root.render(
        <ChatContextNavigationProvider onOpenContextUri={null}>
          <AssistantTurn turn={turn} />
        </ChatContextNavigationProvider>,
      );
    });
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
