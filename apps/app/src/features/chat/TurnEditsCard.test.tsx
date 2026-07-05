import type { Turn } from "@meridian/contracts/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useUndoDraftAccept: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
}));
vi.mock("./ephemeral-undo-store", () => ({
  useEphemeralUndoStore: (selector: (state: { clear: () => void }) => unknown) =>
    selector({ clear: vi.fn() }),
}));

const { TurnEditsCard } = await import("./TurnEditsCard");

function turn(): Turn {
  return {
    id: "turn-1",
    threadId: "thread-1",
    role: "assistant",
    status: "complete",
    createdAt: "2026-07-04T00:00:00.000Z",
    blocks: [],
  } as unknown as Turn;
}

describe("TurnEditsCard", () => {
  it("renders a draft-scope record and the ephemeral undo chip together", () => {
    const html = renderToStaticMarkup(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[{ uri: "context://doc/chapter-1", path: "/chapter-1", scope: "draft" }]}
        ephemeralUndo={{
          threadId: "thread-1",
          hostTurnId: "turn-1",
          projectId: "project-1",
          workId: "work-1",
          documentId: "doc-1",
          draftId: "draft-1",
          documentName: "Chapter 1",
        }}
      />,
    );

    // Collapsed card header carries only the count; the ephemeral chip rides
    // the header because there is no live-scope undo to conflict with.
    expect(html).toContain("data-turn-edits-card");
    expect(html).toContain("Edited 1 document");
    expect(html).toContain("Undo");
  });

  it("lets live-scope documents own the undo path", () => {
    const html = renderToStaticMarkup(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[{ uri: "context://doc/chapter-1", path: "/chapter-1", scope: "live" }]}
        ephemeralUndo={{
          threadId: "thread-1",
          hostTurnId: "turn-1",
          projectId: "project-1",
          workId: "work-1",
          documentId: "doc-1",
          draftId: "draft-1",
          documentName: "Chapter 1",
        }}
      />,
    );

    expect(html).toContain("Edited 1 document");
    // Live scope owns reversal: the whole-turn Undo renders, not the ephemeral chip.
    expect(html).not.toContain("Edited Chapter 1");
    expect(html).toContain("Undo");
  });
});
