// @vitest-environment jsdom
/** Turn receipts count and reveal drafted edits, with reversal failures on the receipt. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReversalOutcome, Turn } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import * as reverseApi from "@/client/api/reverse-api";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import { hasTurnEditsReceiptContent, TurnEditsReceipt } from "./TurnEditsReceipt";

afterEach(() => vi.restoreAllMocks());

it("shows the same document receipt for draft lineage and reverses the selected turn", async () => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const documents = [
    {
      documentId: "chapter",
      path: "chapter.md",
      uri: "manuscript://chapter.md",
      scope: "draft" as const,
    },
  ];
  expect(hasTurnEditsReceiptContent(documents, undefined, [])).toBe(true);
  let answer: (outcome: ReversalOutcome) => void = () => {
    throw new Error("Reversal was not started");
  };
  const reverse = vi.spyOn(reverseApi, "reverseTurn").mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <I18nProvider i18n={i18n}>
          <TurnEditsReceipt
            threadId="chat"
            turn={{ id: "turn" } as Turn}
            documents={documents}
            receipt={{ state: "branch-active", control: "undo" }}
            changeTrail={{
              trailId: "trail",
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
        </I18nProvider>
      </QueryClientProvider>,
      async () => {
        expect(document.body.textContent).toContain("Edited 1 document");
        await act(async () => {
          document.querySelector<HTMLButtonElement>("[aria-expanded]")?.click();
        });
        expect(document.body.textContent).toContain("chapter");
        await act(async () => {
          [...document.querySelectorAll("button")].find((b) => b.textContent === "Undo")?.click();
        });
        expect(document.body.textContent).toContain("Undoing…");
        const pending = [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Undoing…",
        );
        expect(pending?.disabled).toBe(true);
        await act(async () => answer({ status: "nothing_to_undo", documents: [] }));
        await settleReact(() => {
          expect(reverse).toHaveBeenCalledWith("chat", { turnId: "turn", direction: "undo" });
          expect(document.querySelector("[data-undo-unavailable-reason]")?.textContent).toBe(
            "Undo is no longer available.",
          );
        });
      },
      { drainMacrotask: true },
    );
  } finally {
    client.clear();
  }
});

it("counts and reveals pending files alongside an already settled live trail", async () => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const client = new QueryClient();
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
  vi.spyOn(reverseApi, "reverseTurn").mockImplementation(
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
          { documentId: "doc", uri: "manuscript://chapter.md", path: "chapter.md", scope: "draft" },
        ]}
        receipt={receipt}
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
        await act(async () => {
          [...document.querySelectorAll("button")]
            .find((button) => button.textContent === "Undo")
            ?.click();
        });
        expect(document.body.textContent).toContain("Undoing…");
        await act(async () => {
          answer({
            status: "partial",
            documents: [],
            acceptedParts: 1,
            skips: [
              {
                documentId: "doc",
                uri: "manuscript://chapter.md",
                before: "Mara",
                after: "I",
                reason: "discarded",
              },
            ],
          });
          setReceipt({ state: "live-reversed", control: "redo" });
        });
        await settleReact(() => {
          expect(document.querySelector("[data-turn-skips]")?.textContent).toContain(
            "1 part stayed",
          );
          expect(document.body.textContent).toContain("“Mara” → “I”");
          expect(document.body.textContent).toContain("discarded");
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
