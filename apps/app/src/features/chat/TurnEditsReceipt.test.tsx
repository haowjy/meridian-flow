// @vitest-environment jsdom
/** Turn receipts count and reveal drafted edits; reversing is the draft's and the editor's job, not the card's. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Turn } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { changeTrailDetailKey } from "@/client/change-trails";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { TurnEditsReceipt } from "./TurnEditsReceipt";

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
                invisibleWrites: true,
              },
            ]}
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
        expect(document.body.textContent).toContain(
          "Some of this reply's words went into text you discarded.",
        );
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
