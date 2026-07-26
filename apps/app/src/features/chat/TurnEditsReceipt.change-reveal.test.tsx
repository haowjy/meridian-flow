/**
 * The receipt's half of the reveal handshake.
 *
 * A reveal naming a change row expands this receipt and loads its durable
 * evidence. Whatever that evidence turns out to be, the request ends here: the
 * row lands, or the receipt says the row is unavailable and the writer is left
 * on the turn the transcript already brought them to.
 */

import type { Turn } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeTrailShell } from "@/client/change-trails";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
  useChatContextRoutability: () => null,
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({ observe: () => () => {} }),
}));

const mocks = vi.hoisted(() => ({ readChangeTrail: vi.fn() }));
vi.mock("@/client/change-trails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/change-trails")>()),
  readChangeTrail: mocks.readChangeTrail,
}));

const {
  abandonConversationReveal,
  peekConversationReveal,
  requestConversationReveal,
  useConversationRevealRouting,
  useTurnReveal,
} = await import("./conversation-reveal");
const { TurnEditsReceipt } = await import("./TurnEditsReceipt");

const CHANGE_TARGET = {
  kind: "change",
  threadId: "thread-1",
  turnId: "turn-1",
  changeId: "change-1",
} as const;

const turn = {
  id: "turn-1",
  threadId: "thread-1",
  role: "assistant",
  status: "complete",
  createdAt: "2026-07-04T00:00:00.000Z",
  blocks: [],
} as unknown as Turn;

const settledTrail: ChangeTrailShell = {
  trailId: "trail-1",
  owner: { kind: "turn", threadId: "thread-1", turnId: "turn-1" },
  state: "settled",
  version: 1,
  changeCount: 1,
  documentCount: 1,
  documents: [{ documentId: "document-1", title: "Chapter 1" }],
  wordsAdded: 4,
  wordsRemoved: 0,
  updatedAt: "2026-07-04T00:00:00.000Z",
  settledAt: "2026-07-04T00:00:00.000Z",
};

const trailChange = {
  changeId: "change-1",
  ordinal: 0,
  documentId: "document-1",
  pushId: "push-1",
  receiptId: "receipt-1",
  kind: "modify",
  beforeBlockIdentity: null,
  afterBlockIdentity: null,
  beforeText: "block-1|Before text.",
  afterTextAtReceipt: "block-1|After text.",
  navigation: { kind: "unavailable", reason: "test" },
};

/** Shell + transcript: the stages that hand the receipt its request. */
function UpstreamStages() {
  useConversationRevealRouting(() => {});
  const turnReveal = useTurnReveal("thread-1");
  if (turnReveal) queueMicrotask(() => turnReveal.landed());
  return null;
}

function Receipt({ changeTrail }: { changeTrail?: ChangeTrailShell }) {
  return (
    <QueryClientProvider
      client={
        // Trail detail retries twice by policy; only the delay is the test's
        // business, so failures settle in a few macrotasks instead of seconds.
        new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
      }
    >
      <UpstreamStages />
      <TurnEditsReceipt
        threadId="thread-1"
        turn={turn}
        documents={[{ uri: "context://doc/chapter-1", path: "/chapter-1", scope: "live" }]}
        receipt={{ state: "live-active", control: "undo" }}
        changeTrail={changeTrail}
        navigateToChange={vi.fn()}
      />
    </QueryClientProvider>
  );
}

/** React Query batches its post-fetch notify (and each retry) via macrotasks. */
async function settleQueries() {
  for (let flush = 0; flush < 6; flush++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  abandonConversationReveal();
  vi.clearAllMocks();
});

describe("TurnEditsReceipt change reveal", () => {
  it("expands and lands the named row", async () => {
    mocks.readChangeTrail.mockResolvedValue([
      {
        documentId: "document-1",
        documentTitle: "Chapter 1",
        wordsAdded: 4,
        wordsRemoved: 0,
        anchorState: "available",
        changes: [trailChange],
      },
    ]);
    const scrollIntoView = vi.fn();

    await withReactRoot(
      <Receipt changeTrail={settledTrail} />,
      async () => {
        window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
        await act(async () => requestConversationReveal(CHANGE_TARGET));
        await settleQueries();

        expect(document.querySelector("[data-change-view-row]")).not.toBeNull();
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
        expect(peekConversationReveal()).toBeNull();
      },
      { drainMacrotask: true },
    );
  });

  it("degrades to the turn when the evidence request fails", async () => {
    mocks.readChangeTrail.mockRejectedValue(new Error("offline"));

    await withReactRoot(
      <Receipt changeTrail={settledTrail} />,
      async () => {
        await act(async () => requestConversationReveal(CHANGE_TARGET));
        await settleQueries();

        // The receipt still opens with its error state; the request does not
        // survive the failure that could never complete it.
        expect(document.querySelector("[data-turn-receipt]")).not.toBeNull();
        expect(peekConversationReveal()).toBeNull();
      },
      { drainMacrotask: true },
    );
  });

  it("degrades to the turn when the evidence no longer holds the change", async () => {
    mocks.readChangeTrail.mockResolvedValue([
      {
        documentId: "document-1",
        documentTitle: "Chapter 1",
        wordsAdded: 4,
        wordsRemoved: 0,
        anchorState: "available",
        changes: [{ ...trailChange, changeId: "change-other" }],
      },
    ]);

    await withReactRoot(
      <Receipt changeTrail={settledTrail} />,
      async () => {
        await act(async () => requestConversationReveal(CHANGE_TARGET));
        await settleQueries();

        expect(peekConversationReveal()).toBeNull();
      },
      { drainMacrotask: true },
    );
  });

  it("degrades to the turn when the turn carries no durable trail", async () => {
    await withReactRoot(
      <Receipt />,
      async () => {
        await act(async () => requestConversationReveal(CHANGE_TARGET));
        await settleQueries();

        expect(mocks.readChangeTrail).not.toHaveBeenCalled();
        expect(peekConversationReveal()).toBeNull();
      },
      { drainMacrotask: true },
    );
  });
});
