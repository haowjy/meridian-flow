/**
 * Contract: a refused reversal is never silent.
 *
 * The reverse endpoint answers HTTP 200 with a refusal status, so a resolved
 * fetch proves nothing. These tests drive the real path the writer's click
 * takes — query client, mutation, HTTP client, fetch — and assert on what ends
 * up on screen. A unit test over the component alone would have stayed green
 * while a click produced no DOM change at all.
 */
import type { ListTurnLiveLineageResponse, ReversalOutcome } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@/client/stores", () => ({ useIsThreadPendingCreation: () => false }));

const { useTurnLiveLineage } = await import("@/client/query/useTurnLiveLineage");
const { TurnEditsReceipt } = await import("./TurnEditsReceipt");

/**
 * Every status the endpoint can answer with that is not the manuscript
 * changing as asked. Keyed as a record so a status added to the wire union
 * fails this file's typecheck instead of quietly skipping a case.
 */
const REFUSAL_STATUSES: Record<
  Exclude<ReversalOutcome["status"], "success" | "reversed" | "reconciled">,
  true
> = {
  nothing_to_undo: true,
  nothing_to_redo: true,
  cant_undo_dependent: true,
  expired: true,
  partial: true,
  partial_failure: true,
  not_found: true,
  document_not_found: true,
  ambiguous_match: true,
  invalid_write: true,
  internal_error: true,
};

const turn = {
  id: "turn-1",
  threadId: "thread-1",
  role: "assistant",
  status: "complete",
  createdAt: "2026-07-04T00:00:00.000Z",
  blocks: [],
} as never;

const lineageDocument = {
  documentId: "doc-1",
  uri: "manuscript://chapter-1.md",
  path: "/chapter-1.md",
  scope: "live" as const,
};

/** Mirrors how `AssistantTurn` feeds the receipt: server lineage owns the chip. */
function Harness() {
  const lineage = useTurnLiveLineage("thread-1", "turn-1");
  if (!lineage.documents || lineage.documents.length === 0) return null;
  return (
    <TurnEditsReceipt
      threadId="thread-1"
      turn={turn}
      documents={lineage.documents}
      receipt={lineage.receipt}
    />
  );
}

function lineageResponse(receipt: ListTurnLiveLineageResponse["receipt"]): Response {
  return jsonResponse({
    documents: [lineageDocument],
    receipt,
  } satisfies ListTurnLiveLineageResponse);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ReceiptView = {
  /** Everything on screen, chrome included. */
  text: string;
  /** The receipt's one explanation slot. Empty means the writer learned nothing. */
  reason: string;
};

/** Renders the receipt, clicks the named command, and reports what a writer sees. */
async function clickReversal(
  command: "Undo" | "Redo",
  reverseResponse: () => Response,
  options: { receiptAfterRefusal?: ListTurnLiveLineageResponse["receipt"] } = {},
): Promise<ReceiptView> {
  const restingReceipt: ListTurnLiveLineageResponse["receipt"] =
    command === "Redo"
      ? { state: "live-reversed", control: "redo" }
      : { state: "live-active", control: "undo" };
  let lineageFetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!String(url).includes("live-lineage")) return reverseResponse();
      lineageFetches += 1;
      const refreshed = options.receiptAfterRefusal ?? restingReceipt;
      return lineageResponse(lineageFetches === 1 ? restingReceipt : refreshed);
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view: ReceiptView = { text: "", reason: "" };

  try {
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await settle();
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === command,
        );
        if (!button) throw new Error(`missing ${command}: ${document.body.textContent}`);
        await act(async () => {
          button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        });
        await settle();
        view.text = document.body.textContent ?? "";
        view.reason =
          document.querySelector("[data-undo-unavailable-reason]")?.textContent?.trim() ?? "";
      },
      { drainMacrotask: true },
    );
  } finally {
    queryClient.clear();
    vi.unstubAllGlobals();
  }
  return view;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("TurnEditsReceipt reversal refusals", () => {
  it("explains the dependent-edits refusal the server answers 200 with", async () => {
    const view = await clickReversal("Undo", () =>
      jsonResponse({
        status: "cant_undo_dependent",
        documents: [
          {
            uri: "manuscript://chapter-1.md",
            status: "cant_undo_dependent",
            text: "status: cant_undo_dependent\n\nThis turn has later live edits depending on it. View the change instead of undoing it.",
          },
        ],
      } satisfies ReversalOutcome),
    );

    expect(view.reason).toContain("Later edits build on this change.");
    expect(view.reason).toContain("View the change instead of undoing it.");
    // The dock localizes; the server's message code never reaches the writer.
    expect(view.text).not.toContain("status: cant_undo_dependent");
  });

  it("keeps the refusal on screen when the refreshed receipt withdraws Undo", async () => {
    const view = await clickReversal(
      "Undo",
      () =>
        jsonResponse({
          status: "cant_undo_dependent",
          documents: [{ uri: "manuscript://chapter-1.md", status: "cant_undo_dependent" }],
        } satisfies ReversalOutcome),
      { receiptAfterRefusal: { state: "cant_undo_dependent", control: "view_change" } },
    );

    expect(view.text).toContain("Can't undo");
    expect(view.reason).toContain("Later edits build on this change.");
  });

  it("explains a reversal the server rejected with an HTTP error", async () => {
    const view = await clickReversal("Undo", () =>
      jsonResponse({ message: "Document not found" }, 404),
    );

    expect(view.reason).toBe("Undo didn't go through. Try again.");
  });

  it("names the command the writer pressed when Redo fails", async () => {
    const view = await clickReversal("Redo", () =>
      jsonResponse({ message: "Document not found" }, 404),
    );

    expect(view.reason).toBe("Redo didn't go through. Try again.");
  });

  // The assertion that fails if silent refusals come back: every status the
  // endpoint can answer with fills the receipt's explanation slot.
  it.each(Object.keys(REFUSAL_STATUSES))("explains a %s outcome", async (status) => {
    const view = await clickReversal("Undo", () =>
      jsonResponse({
        status,
        documents: [{ uri: "manuscript://chapter-1.md", status }],
      }),
    );

    expect(view.reason).not.toBe("");
  });
});
