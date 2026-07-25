import type { ReversalOutcome, Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChangeTrailShell } from "@/client/change-trails";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { dismissGroupMock, mutateAsyncMock } = vi.hoisted(() => ({
  dismissGroupMock: vi.fn(),
  mutateAsyncMock: vi.fn<() => Promise<Pick<ReversalOutcome, "status">>>(),
}));

vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: mutateAsyncMock }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    peek: () => ({ markerStore: { dismissGroup: dismissGroupMock } }),
  }),
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

const liveDocument = { uri: "context://doc/chapter-1", path: "/chapter-1", scope: "live" } as const;
const settledTrail = {
  trailId: "trail-1",
  owner: { kind: "turn", threadId: "thread-1", turnId: "turn-1" },
  state: "settled",
  version: 1,
  changeCount: 3,
  writerImpactCount: 0,
  documentCount: 1,
  documents: [{ documentId: "document-1", title: "chapter-1" }],
  wordsAdded: 20,
  wordsRemoved: 0,
  updatedAt: "2026-07-04T00:00:00.000Z",
  settledAt: "2026-07-04T00:00:00.000Z",
} satisfies ChangeTrailShell;

async function withInteractiveCard(
  props: Partial<React.ComponentProps<typeof TurnEditsCard>>,
  run: (card: { click(label: string): Promise<void> }) => Promise<void>,
): Promise<void> {
  await withReactRoot(
    <TurnEditsCard
      threadId="thread-1"
      turn={turn()}
      documents={[liveDocument]}
      receipt={{ state: "live-active", control: "undo" }}
      {...props}
    />,
    // Inside the callback the JSDOM globals are live, so `document`/`window`
    // refer to the rendered card's DOM.
    async () => {
      await run({
        async click(label: string) {
          const button = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === label,
          );
          if (!button) throw new Error(`missing button ${label}`);
          await act(async () =>
            button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
          );
        },
      });
    },
  );
}

describe("TurnEditsCard", () => {
  /**
   * A receipt may exist only for what actually reached the manuscript.
   *
   * Both shapes are the same turn that only ever drafted: `live` is the turn
   * still held in memory, `reload` is it rebuilt from a settled trail naming no
   * document. A card in either case tells the writer their chapter changed when
   * it did not — and it only appears after a reload, so nobody would catch it by
   * using the app.
   */
  it.each([
    ["live", undefined],
    [
      "reload",
      {
        trailId: "trail-1",
        owner: { kind: "turn", threadId: "thread-1", turnId: "turn-1" },
        state: "settled",
        version: 1,
        changeCount: 1,
        writerImpactCount: 0,
        documentCount: 0,
        documents: [],
        wordsAdded: null,
        wordsRemoved: null,
        updatedAt: "2026-07-04T00:00:00.000Z",
        settledAt: "2026-07-04T00:00:00.000Z",
      } satisfies ChangeTrailShell,
    ],
  ])("renders no card for draft-only lineage in the %s shape", (_shape, changeTrail) => {
    const html = renderToStaticMarkup(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[{ uri: "context://doc/chapter-1", path: "/chapter-1", scope: "draft" }]}
        receipt={{ state: "branch-active", control: "undo" }}
        changeTrail={changeTrail}
      />,
    );

    expect(html).toBe("");
  });

  it("lets live-scope documents own the undo path", () => {
    const html = renderToStaticMarkup(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[liveDocument]}
        receipt={{ state: "live-active", control: "undo" }}
      />,
    );

    expect(html).toContain("Edited chapter-1");
    expect(html).toContain("Undo");
  });

  it("keeps Undo visible when the reverse endpoint reports no undo happened", async () => {
    mutateAsyncMock.mockResolvedValueOnce({ status: "nothing_to_undo" });
    await withInteractiveCard({}, async (card) => {
      await card.click("Undo");

      expect(document.body.textContent).toContain("Undo");
      expect(document.body.textContent).not.toContain("Redo");
    });
  });

  it("clears ordinary trail marks without requiring writer-impact rows", async () => {
    dismissGroupMock.mockReset();
    await withInteractiveCard({ changeTrail: settledTrail }, async (card) => {
      const clearButton = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Clear marks",
      );
      expect(clearButton?.dataset.size).toBe("meta");

      await card.click("Clear marks");

      expect(dismissGroupMock).toHaveBeenCalledWith({
        trailId: "trail-1",
        documentId: "document-1",
      });
    });
  });

  it("renders Redo from a server reversed receipt", () => {
    const html = renderToStaticMarkup(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[liveDocument]}
        receipt={{ state: "live-reversed", control: "redo" }}
      />,
    );

    expect(html).toContain("Redo");
    expect(html).not.toContain("Undo");
  });

  it("does not locally flip Undo to Redo; server receipt owns state", async () => {
    mutateAsyncMock.mockResolvedValueOnce({ status: "reversed" });
    await withInteractiveCard({}, async (card) => {
      await card.click("Undo");

      expect(document.body.textContent).toContain("Undo");
      expect(document.body.textContent).not.toContain("Redo");
    });
  });
  it("guards Undo when later rows depend on the change", () => {
    const html = renderToStaticMarkup(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[liveDocument]}
        receipt={{ state: "cant_undo_dependent", control: "view_change" }}
      />,
    );
    expect(html).toContain("Can&#x27;t undo");
    expect(html).toContain("Later edits build on this change.");
  });

  it("uses neutral copy when Undo expired without a dependent row", () => {
    const html = renderToStaticMarkup(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[liveDocument]}
        receipt={{ state: "expired", control: "view_change" }}
      />,
    );
    expect(html).toContain("Can&#x27;t undo");
    expect(html).toContain("This change is too old to undo.");
    expect(html).not.toContain("Later edits build");
  });
});
