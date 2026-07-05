import type { Turn } from "@meridian/contracts/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { documentsRef } = vi.hoisted(() => ({
  documentsRef: {
    current: null as null | { uri: string; path: string; scope: "live" | "draft" }[],
  },
}));

vi.mock("@/client/query/useTurnLiveLineage", () => ({
  useTurnLiveLineage: () => ({ documents: documentsRef.current }),
}));
vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
}));

const { AssistantTurn } = await import("./AssistantTurn");

function turn(id: string): Turn {
  return {
    id,
    threadId: "thread-1",
    role: "assistant",
    status: "complete",
    createdAt: "2026-07-04T00:00:00.000Z",
    blocks: [],
  } as unknown as Turn;
}

describe("AssistantTurn edit lineage", () => {
  it("renders no edit card without lineage documents", () => {
    documentsRef.current = [];
    const html = renderToStaticMarkup(<AssistantTurn threadId="thread-1" turn={turn("turn-1")} />);
    expect(html).not.toContain("data-turn-edits-card");
  });

  it("renders the edit card from server lineage", () => {
    documentsRef.current = [{ uri: "context://doc/chapter-1", path: "/chapter-1", scope: "live" }];
    const html = renderToStaticMarkup(<AssistantTurn threadId="thread-1" turn={turn("turn-1")} />);
    expect(html).toContain("data-turn-edits-card");
    expect(html).toContain("Undo");
  });
});
