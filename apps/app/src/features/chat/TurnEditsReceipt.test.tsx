// @vitest-environment jsdom
/** Turn receipts count and reveal drafted edits, with reversal failures on the receipt. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReversalOutcome, Turn } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import * as reverseApi from "@/client/api/reverse-api";
import { changeTrailDetailKey } from "@/client/change-trails";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import { hasTurnEditsReceiptContent, TurnEditsReceipt } from "./TurnEditsReceipt";

afterEach(() => vi.restoreAllMocks());

it("counts and reveals pending files alongside an already settled live trail", async () => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const client = new QueryClient();
  client.setQueryData(changeTrailDetailKey("chat", "trail"), [
    {
      trailId: "trail",
      documentId: "live",
      documentTitle: "live",
      wordsAdded: 1,
      wordsRemoved: 1,
      anchorState: "available",
      changes: [
        {
          changeId: "change",
          ordinal: 0,
          documentId: "live",
          pushId: null,
          receiptId: null,
          kind: "modify",
          beforeBlockIdentity: null,
          afterBlockIdentity: null,
          beforeText: "Saved before.",
          afterTextAtReceipt: "Saved after.",
          navigation: { kind: "unavailable" },
        },
      ],
    },
  ]);
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <I18nProvider i18n={i18n}>
          <TurnEditsReceipt
            threadId="chat"
            turn={{ id: "turn" } as Turn}
            documents={[
              { documentId: "live", uri: "manuscript://live.md", path: "live.md", scope: "live" },
              {
                documentId: "pending",
                uri: "manuscript://pending.md",
                path: "pending.md",
                scope: "draft",
              },
            ]}
            receipt={{ state: "live-active", control: "undo" }}
            navigateToChange={async () => ({ kind: "unavailable" })}
            changeTrail={{
              trailId: "trail",
              owner: { kind: "turn", threadId: "chat", turnId: "turn" },
              state: "settled",
              version: 1,
              changeCount: 1,
              documentCount: 1,
              documents: [{ documentId: "live", title: "live" }],
              wordsAdded: 1,
              wordsRemoved: 0,
              updatedAt: "",
              settledAt: "",
            }}
          />
        </I18nProvider>
      </QueryClientProvider>,
      async () => {
        expect(document.body.textContent).toContain("Edited 2 documents");
        await act(async () =>
          document.querySelector<HTMLButtonElement>("[aria-expanded]")?.click(),
        );
        expect(document.body.textContent).toContain("pending");
        expect(document.body.textContent).toContain("live");
        expect(document.querySelector('[data-change-view-row="modify"]')?.textContent).toContain(
          "Saved before.",
        );
        expect(document.querySelector('[data-change-view-row="modify"]')?.textContent).toContain(
          "Saved after.",
        );
        expect(document.querySelector('section[aria-label="live"]')?.textContent).not.toContain(
          "pending",
        );
      },
    );
  } finally {
    client.clear();
  }
});

it("keeps the card's named partial result, pending Redo and failure beside its authoritative states", async () => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let setReceipt: (receipt: import("@meridian/contracts/protocol").TurnReceiptChip) => void =
    () => {};
  let answer: (result: ReversalOutcome) => void = () => {};
  let fail: (reason: Error) => void = () => {};
  const reverse = vi.spyOn(reverseApi, "reverseTurn").mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
  );
  function Card() {
    const [receipt, set] = useState<import("@meridian/contracts/protocol").TurnReceiptChip>({
      state: "live-active",
      control: "undo",
    });
    setReceipt = set;
    return (
      <TurnEditsReceipt
        threadId="chat"
        turn={{ id: "turn" } as Turn}
        documents={[
          {
            documentId: "doc",
            uri: "manuscript://chapter.md",
            path: "chapter.md",
            scope: "draft",
          },
        ]}
        receipt={receipt}
        changeTrail={{
          trailId: "empty",
          owner: { kind: "turn", threadId: "chat", turnId: "turn" },
          state: "settled",
          version: 1,
          changeCount: 0,
          documentCount: 0,
          documents: [],
          wordsAdded: null,
          wordsRemoved: null,
          updatedAt: "",
          settledAt: null,
        }}
        navigateToChange={async () => ({ kind: "unavailable" })}
      />
    );
  }
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <I18nProvider i18n={i18n}>
          <Card />
        </I18nProvider>
      </QueryClientProvider>,
      async () => {
        expect(
          hasTurnEditsReceiptContent(
            [
              {
                documentId: "doc",
                path: "chapter.md",
                uri: "manuscript://chapter.md",
                scope: "draft",
              },
            ],
            undefined,
            [],
          ),
        ).toBe(true);
        expect(document.body.textContent).toContain("Edited 1 document");
        await act(async () =>
          document.querySelector<HTMLButtonElement>("[aria-expanded]")?.click(),
        );
        expect(document.body.textContent).toContain("chapter");
        await act(async () => {
          [...document.querySelectorAll("button")]
            .find((button) => button.textContent === "Undo")
            ?.click();
        });
        expect(document.body.textContent).toContain("Undoing…");
        expect(
          [...document.querySelectorAll("button")].find(
            (button) => button.textContent === "Undoing…",
          )?.disabled,
        ).toBe(true);
        expect(reverse).toHaveBeenCalledWith("chat", { turnId: "turn", direction: "undo" });
        await act(async () => {
          answer({
            status: "partial",
            documents: [
              {
                documentId: "document-1",
                uri: "manuscript://chapter.md",
                status: "reversed",
                destination: { kind: "draft", branchId: "branch" },
              },
            ],
            acceptedParts: 1,
            skips: [
              {
                kind: "text",
                documentId: "doc",
                uri: "manuscript://chapter.md",
                before: "Mara",
                after: "I",
                cause: "discarded",
              },
            ],
          });
          setReceipt({ state: "live-reversed", control: "redo" });
        });
        await settleReact(() => {
          expect(document.querySelector("[data-turn-skips]")?.textContent).toContain(
            "Undo left 1 part as it was",
          );
          expect(document.body.textContent).toContain("“Mara” → “I”");
          expect(document.body.textContent).toContain("Discarded");
        });
        await act(async () => {
          [...document.querySelectorAll("button")]
            .find((button) => button.textContent === "Redo")
            ?.click();
        });
        expect(document.body.textContent).toContain("Redoing…");
        await act(async () => {
          fail(new Error("offline"));
        });
        await settleReact(() => {
          expect(document.querySelector("[data-undo-unavailable-reason]")).not.toBeNull();
        });
        await act(async () => setReceipt({ state: "expired", control: "view_change" }));
        expect(document.querySelector("[data-undo-unavailable]")?.textContent).toBe("Can't undo");
      },
      { drainMacrotask: true },
    );
  } finally {
    client.clear();
  }
});
