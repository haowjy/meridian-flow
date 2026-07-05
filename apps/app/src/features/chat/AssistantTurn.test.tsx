import type { Turn } from "@meridian/contracts/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@/client/query/useTurnLiveLineage", () => ({
  useTurnLiveLineage: () => ({ documents: null }),
}));
vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useUndoDraftAccept: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
}));

const { entryRef } = vi.hoisted(() => ({
  entryRef: {
    current: {
      threadId: "thread-1",
      hostTurnId: "turn-1",
      projectId: "project-1",
      workId: "work-1",
      documentId: "doc-1",
      draftId: "draft-1",
      documentName: "Chapter 1",
    } as unknown,
  },
}));

vi.mock("./ephemeral-undo-store", () => ({
  useEphemeralUndoStore: (selector: (state: { entry: unknown; clear: () => void }) => unknown) =>
    selector({ entry: entryRef.current, clear: vi.fn() }),
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

describe("AssistantTurn ephemeral undo host", () => {
  it("shows the chip only on the assistant turn that was latest when Apply happened", () => {
    const hostHtml = renderToStaticMarkup(
      <AssistantTurn threadId="thread-1" turn={turn("turn-1")} isLatestAssistant />,
    );
    const laterHtml = renderToStaticMarkup(
      <AssistantTurn threadId="thread-1" turn={turn("turn-2")} isLatestAssistant />,
    );

    expect(hostHtml).toContain("Undo");
    expect(laterHtml).not.toContain("Undo");
  });
});
