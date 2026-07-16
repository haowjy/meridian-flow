import type { ReversalOutcome, Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { mutateAsyncMock } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn<() => Promise<Pick<ReversalOutcome, "status">>>(),
}));

vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: mutateAsyncMock }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
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
  it("renders draft-only lineage with turn undo authority", () => {
    const html = renderToStaticMarkup(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[{ uri: "context://doc/chapter-1", path: "/chapter-1", scope: "draft" }]}
        receipt={{ state: "branch-active", control: "undo" }}
      />,
    );

    expect(html).toContain("data-turn-edits-card");
    expect(html).toContain("AI edited 1 chapter");
    expect(html).toContain("Undo");
    expect(html).not.toContain("Redo");
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

    expect(html).toContain("AI edited 1 chapter");
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
    expect(html).toContain("This change is too old to undo.");
    expect(html).not.toContain("Later edits build");
  });
});
