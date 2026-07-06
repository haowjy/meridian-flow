import { createRequire } from "node:module";
import type { ReversalOutcome, Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { mutateAsyncMock, getTurnChangeDiffMock } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn<() => Promise<Pick<ReversalOutcome, "status">>>(),
  getTurnChangeDiffMock: vi.fn(),
}));

vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: mutateAsyncMock }),
}));
vi.mock("@/client/api/turn-change-diff-api", () => ({
  getTurnChangeDiff: getTurnChangeDiffMock,
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
}));

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close: () => void } };
};

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

async function renderInteractiveCard(
  props: Partial<React.ComponentProps<typeof TurnEditsCard>> = {},
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const rootNode = dom.window.document.getElementById("root");
  if (!rootNode) throw new Error("missing root");
  const root = createRoot(rootNode);
  await act(async () => {
    root.render(
      <TurnEditsCard
        threadId="thread-1"
        turn={turn()}
        documents={[liveDocument]}
        receipt={{ state: "live-active", control: "undo" }}
        {...props}
      />,
    );
  });
  return {
    document: dom.window.document,
    async click(label: string) {
      const button = [...dom.window.document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!button) throw new Error(`missing button ${label}`);
      await act(async () =>
        button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
      );
    },
    async cleanup() {
      await act(async () => root.unmount());
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      dom.window.close();
    },
  };
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
    expect(html).toContain("Edited 1 document");
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

    expect(html).toContain("Edited 1 document");
    expect(html).toContain("Undo");
  });

  it("keeps Undo visible when the reverse endpoint reports no undo happened", async () => {
    mutateAsyncMock.mockResolvedValueOnce({ status: "nothing_to_undo" });
    const card = await renderInteractiveCard();
    try {
      await card.click("Undo");

      expect(card.document.body.textContent).toContain("Undo");
      expect(card.document.body.textContent).not.toContain("Redo");
    } finally {
      await card.cleanup();
    }
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
    const card = await renderInteractiveCard();
    try {
      await card.click("Undo");

      expect(card.document.body.textContent).toContain("Undo");
      expect(card.document.body.textContent).not.toContain("Redo");
    } finally {
      await card.cleanup();
    }
  });
  it("opens the View change dialog from a degraded receipt chip", async () => {
    getTurnChangeDiffMock.mockResolvedValueOnce({
      version: 1,
      source: "pushed",
      documents: [
        {
          documentId: "doc-1",
          blocks: [{ blockId: "block-1", beforeText: "Before", afterText: "After" }],
        },
      ],
    });
    const card = await renderInteractiveCard({
      receipt: { state: "expired", control: "view_change" },
    });
    try {
      await card.click("View change");

      expect(getTurnChangeDiffMock).toHaveBeenCalledWith("thread-1", "turn-1");
      expect(card.document.body.textContent).toContain("Changed by this turn");
    } finally {
      await card.cleanup();
    }
  });
});
