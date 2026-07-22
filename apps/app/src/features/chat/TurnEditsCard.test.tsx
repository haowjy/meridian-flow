import type { ReversalOutcome, Turn } from "@meridian/contracts/protocol";
import { act } from "react";
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

const { TurnUndoReceipt } = await import("./TurnEditsCard");

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

async function withInteractiveReceipt(
  props: Partial<React.ComponentProps<typeof TurnUndoReceipt>>,
  run: (card: { click(label: string): Promise<void> }) => Promise<void>,
): Promise<void> {
  await withReactRoot(
    <TurnUndoReceipt
      threadId="thread-1"
      turn={turn()}
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

describe("TurnUndoReceipt", () => {
  it("keeps Undo visible when the reverse endpoint reports no undo happened", async () => {
    mutateAsyncMock.mockResolvedValueOnce({ status: "nothing_to_undo" });
    await withInteractiveReceipt({}, async (card) => {
      await card.click("Undo");

      expect(document.body.textContent).toContain("Undo");
      expect(document.body.textContent).not.toContain("Redo");
    });
  });

  it("renders Redo from a server reversed receipt", () => {
    return withInteractiveReceipt(
      { receipt: { state: "live-reversed", control: "redo" } },
      async () => {
        expect(document.body.textContent).toContain("Redo");
        expect(document.body.textContent).not.toContain("Undo");
      },
    );
  });

  it("does not locally flip Undo to Redo; server receipt owns state", async () => {
    mutateAsyncMock.mockResolvedValueOnce({ status: "reversed" });
    await withInteractiveReceipt({}, async (card) => {
      await card.click("Undo");

      expect(document.body.textContent).toContain("Undo");
      expect(document.body.textContent).not.toContain("Redo");
    });
  });
  it("guards Undo when later rows depend on the change", () => {
    return withInteractiveReceipt(
      { receipt: { state: "cant_undo_dependent", control: "view_change" } },
      async () => {
        const button = document.querySelector("button");
        expect(button?.disabled).toBe(true);
        expect(button?.title).toContain("later edits depend");
      },
    );
  });

  it("uses neutral copy when Undo expired without a dependent row", () => {
    return withInteractiveReceipt(
      { receipt: { state: "expired", control: "view_change" } },
      async () => {
        const title = document.querySelector("button")?.title;
        expect(title).toContain("Undo is no longer available");
        expect(title).not.toContain("later edits depend");
      },
    );
  });
});
