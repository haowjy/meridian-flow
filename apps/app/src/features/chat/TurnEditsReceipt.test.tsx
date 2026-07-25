import type { ReversalOutcome, Turn, TurnReceiptChip } from "@meridian/contracts/protocol";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeTrailShell } from "@/client/change-trails";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { mutateAsyncMock, contextNavigation } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn<() => Promise<Pick<ReversalOutcome, "status">>>(),
  contextNavigation: {
    current: null as ((uri: string) => void) | null,
    canOpen: null as ((uri: string) => boolean) | null,
  },
}));

vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: mutateAsyncMock }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => contextNavigation.current,
  useChatContextRoutability: () => contextNavigation.canOpen,
}));
const { TurnEditsReceipt } = await import("./TurnEditsReceipt");

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
  documentCount: 1,
  documents: [{ documentId: "document-1", title: "chapter-1" }],
  wordsAdded: 20,
  wordsRemoved: 0,
  updatedAt: "2026-07-04T00:00:00.000Z",
  settledAt: "2026-07-04T00:00:00.000Z",
} satisfies ChangeTrailShell;

async function withInteractiveCard(
  props: Partial<React.ComponentProps<typeof TurnEditsReceipt>>,
  run: (card: { click(label: string): Promise<void> }) => Promise<void>,
): Promise<void> {
  await withReactRoot(
    <TurnEditsReceipt
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

describe("TurnEditsReceipt", () => {
  beforeEach(() => {
    contextNavigation.current = null;
    contextNavigation.canOpen = null;
  });

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
      <TurnEditsReceipt
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
      <TurnEditsReceipt
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
      expect(document.body.textContent).toContain("Undo is no longer available.");
    });
  });

  it("surfaces a raced redo refusal instead of silently doing nothing", async () => {
    mutateAsyncMock.mockResolvedValueOnce({ status: "nothing_to_redo" });
    await withInteractiveCard(
      { receipt: { state: "live-reversed", control: "redo" } },
      async (card) => {
        await card.click("Redo");

        expect(document.body.textContent).toContain(
          "Redo is no longer available because the manuscript changed.",
        );
      },
    );
  });

  it("retains a raced refusal when refreshed receipt state withdraws the action", async () => {
    mutateAsyncMock.mockResolvedValueOnce({ status: "nothing_to_redo" });
    let withdrawRedo: (() => void) | undefined;
    function Scenario() {
      const [receipt, setReceipt] = useState<TurnReceiptChip>({
        state: "live-reversed" as const,
        control: "redo" as const,
      });
      withdrawRedo = () =>
        setReceipt({ state: "expired" as const, control: "view_change" as const });
      return (
        <TurnEditsReceipt
          threadId="thread-1"
          turn={turn()}
          documents={[liveDocument]}
          receipt={receipt}
        />
      );
    }

    await withReactRoot(<Scenario />, async () => {
      const redo = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Redo",
      );
      if (!redo) throw new Error("missing Redo button");
      await act(async () => redo.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
      await act(async () => withdrawRedo?.());

      expect(document.body.textContent).toContain("Can't undo");
      expect(document.body.textContent).toContain(
        "Redo is no longer available because the manuscript changed.",
      );
    });
  });

  it("keeps the collapsed receipt free of bookkeeping controls", async () => {
    await withInteractiveCard({ changeTrail: settledTrail }, async () => {
      expect(document.body.textContent).not.toContain("Clear marks");
    });
  });

  it("renders Redo from a server reversed receipt", () => {
    const html = renderToStaticMarkup(
      <TurnEditsReceipt
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
  it("puts the dependent-change Undo reason behind expansion", async () => {
    await withInteractiveCard(
      { receipt: { state: "cant_undo_dependent", control: "view_change" } },
      async () => {
        expect(document.body.textContent).toContain("Can't undo");
        expect(document.body.textContent).not.toContain("Later edits build on this change.");
        const toggle = document.querySelector<HTMLButtonElement>("[aria-controls]");
        if (!toggle) throw new Error("missing receipt toggle");
        await act(async () => toggle.click());
        expect(document.body.textContent).toContain("Later edits build on this change.");
      },
    );
  });

  it("uses neutral copy when Undo expired without a dependent row", () => {
    const html = renderToStaticMarkup(
      <TurnEditsReceipt
        threadId="thread-1"
        turn={turn()}
        documents={[liveDocument]}
        receipt={{ state: "expired", control: "view_change" }}
      />,
    );
    expect(html).toContain("Can&#x27;t undo");
    expect(html).not.toContain("This change is too old to undo.");
    expect(html).not.toContain("Later edits build");
  });

  it("links a document name only when its URI is routable", async () => {
    const openContextUri = vi.fn();
    contextNavigation.current = openContextUri;
    contextNavigation.canOpen = () => true;
    const receiptDocument = {
      uri: "manuscript://arc/chapter-1.mdx",
      path: "/arc/chapter-1.mdx",
      scope: "live" as const,
    };

    await withInteractiveCard({ documents: [receiptDocument] }, async (card) => {
      await act(async () => document.querySelector<HTMLButtonElement>("[aria-controls]")?.click());
      await card.click("chapter-1");
      expect(openContextUri).toHaveBeenCalledWith(receiptDocument.uri);
    });
  });

  it("does not make provider presence look like a routable work document", async () => {
    contextNavigation.current = vi.fn();
    contextNavigation.canOpen = () => false;
    await withInteractiveCard(
      {
        documents: [
          {
            uri: "scratch://notes/beat.md",
            path: "/notes/beat.md",
            scope: "live",
          },
        ],
      },
      async () => {
        await act(async () =>
          document.querySelector<HTMLButtonElement>("[aria-controls]")?.click(),
        );
        const beatButtons = [...document.querySelectorAll("button")].filter(
          (button) => button.textContent?.trim() === "beat.md",
        );
        expect(beatButtons).toHaveLength(0);
      },
    );
  });
});
