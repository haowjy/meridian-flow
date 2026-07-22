// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TrailChange } from "@/client/change-trails";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { ChangeViewRows } = await import("./ChangeViewRows");

// Captured from the G8 S2 durable detail before the diagnostic Restore. Keep
// this wire-shaped instead of rebuilding the row through component props: the
// navigation/identity combination is the contract this regression protects.
const g8SweptDocument = {
  trailId: "69299ae0-20ee-5141-9ad1-500695d0aa4d",
  documentId: "b73429d4-835c-4b4f-bfa7-8f0a8007b1af",
  documentTitle: "g8-s2-exact.md",
  changes: [
    {
      changeId:
        "e5004fc3-b26e-4153-b7ea-51bfbcdf7540:b73429d4-835c-4b4f-bfa7-8f0a8007b1af:3756363870:0",
      ordinal: 0,
      documentId: "b73429d4-835c-4b4f-bfa7-8f0a8007b1af",
      pushId: "6",
      receiptId: "e5004fc3-b26e-4153-b7ea-51bfbcdf7540",
      kind: "delete",
      beforeBlockId: "7594",
      afterBlockId: "7594",
      beforeBlockIdentity: {
        documentId: "b73429d4-835c-4b4f-bfa7-8f0a8007b1af",
        clientID: 3756363870,
        clock: 0,
      },
      beforeText:
        "7594|G8 EXACT V2 VERBATIM: violet foxes stitched new constellations beneath the bridge.G8 EXACT V1 ONE: silver rain crossed the harbor.",
      afterTextAtReceipt: "G8 EXACT AGENT FINAL: obsidian wings crossed the winter sun.",
      afterBlockIdentity: {
        documentId: "b73429d4-835c-4b4f-bfa7-8f0a8007b1af",
        clientID: 3756363870,
        clock: 0,
      },
      navigation: { kind: "unavailable", reason: "capture_failed" },
      swept: {
        removed: {
          status: "available",
          markdown:
            "G8 EXACT V2 VERBATIM: violet foxes stitched new constellations beneath the bridge.G8 EXACT V1 ONE: silver rain crossed the harbor.",
        },
      },
      writerProtection: {
        kind: "sweep",
        body: {
          status: "available",
          markdown:
            "G8 EXACT V2 VERBATIM: violet foxes stitched new constellations beneath the bridge.G8 EXACT V1 ONE: silver rain crossed the harbor.",
        },
      },
      reversible: false,
    },
  ],
} satisfies {
  trailId: string;
  documentId: string;
  documentTitle: string;
  changes: TrailChange[];
};

const g8OrdinaryDocument = {
  trailId: "857c3776-6284-5196-bab8-469d08e51a1e",
  documentId: "7a59f55a-ee6f-4659-99b4-17fde01a174c",
  changes: [
    {
      changeId: "g8-s10-ordinary-change",
      ordinal: 0,
      documentId: "7a59f55a-ee6f-4659-99b4-17fde01a174c",
      kind: "delete",
      beforeText:
        "g8-s10-before|G8 S10 CAPTURED ORDINARY BODY: quiet dragons guarded the western gate.",
      afterTextAtReceipt: null,
      navigation: { kind: "unavailable", reason: "document_deleted" },
      swept: null,
      reversible: false,
    },
  ],
} satisfies { trailId: string; documentId: string; changes: TrailChange[] };

function protectedChange(kind: "sweep" | "resurrection"): TrailChange {
  return {
    changeId: `change-${kind}`,
    ordinal: 1,
    documentId: "document-1",
    kind: kind === "sweep" ? "delete" : "insert",
    beforeText: null,
    afterTextAtReceipt: null,
    navigation: {
      kind: "deletion_boundary",
      position: "encoded-position",
      affinity: "before_next",
    },
    swept: null,
    writerProtection: {
      kind,
      body: { status: "available", markdown: "The writer's exact words." },
    },
    reversible: false,
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button: ${label}`);
  return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("ChangeViewRows", () => {
  it("offers Restore for the durable G8 capture-failed row with retained canonical identity", async () => {
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId={g8SweptDocument.trailId}
        documentId={g8SweptDocument.documentId}
        changes={g8SweptDocument.changes}
        navigateToChange={vi.fn(async () => ({ kind: "unavailable" as const }))}
      />,
      async () => {
        expect(document.body.textContent).toContain("Restore");
        expect(document.body.textContent).not.toContain("Copy");
        await click("Removed");
        expect(document.body.textContent).toContain("Restore");
        expect(document.body.textContent).not.toContain("Copy");
      },
    );
  });

  it("shows captured sweep words and applies Restore only once", async () => {
    const runAction = vi.fn(async () => ({ status: "applied" as const }));
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[protectedChange("sweep")]}
        navigateToChange={vi.fn(async () => ({ kind: "shown" as const }))}
        runAction={runAction}
      />,
      async () => {
        expect(document.body.textContent).toContain("Removed");
        expect(document.body.textContent).toContain("The writer's exact words.");
        await click("Restore");
        expect(document.body.textContent).toContain("Restored");
        expect(
          [...document.querySelectorAll("button")].some((item) => item.textContent === "Restore"),
        ).toBe(false);
        expect(runAction).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("degrades Restore to Copy when live-root validation rejects the anchor", async () => {
    const copyText = vi.fn(async () => {});
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[protectedChange("sweep")]}
        navigateToChange={vi.fn(async () => ({ kind: "shown" as const }))}
        runAction={vi.fn(async () => ({ status: "anchor_unavailable" as const }))}
        copyText={copyText}
      />,
      async () => {
        await click("Restore");
        expect(document.body.textContent).toContain(
          "This passage can't be restored in place. Copy it instead.",
        );
        await click("Copy");
        expect(copyText).toHaveBeenCalledWith("The writer's exact words.");
        expect(document.body.textContent).toContain("Copied");
      },
    );
  });

  it("keeps Restore available and explains a failed request", async () => {
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[protectedChange("sweep")]}
        navigateToChange={vi.fn(async () => ({ kind: "shown" as const }))}
        runAction={vi.fn(async () => {
          throw new Error("request failed");
        })}
      />,
      async () => {
        await click("Restore");
        expect(document.body.textContent).toContain(
          "Couldn't restore the passage. Try again, or copy it instead.",
        );
        expect(button("Restore").disabled).toBe(false);
        expect(button("Copy")).toBeTruthy();
      },
    );
  });

  it("explains clipboard failure", async () => {
    const change = protectedChange("sweep");
    change.forwardActions = {
      restore: { status: "settled", outcome: "anchor_unavailable" },
    };
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[change]}
        navigateToChange={vi.fn(async () => ({ kind: "unavailable" as const }))}
        copyText={vi.fn(async () => {
          throw new Error("clipboard denied");
        })}
      />,
      async () => {
        await click("Copy");
        expect(document.body.textContent).toContain(
          "Couldn't copy. Select the saved text and copy it manually.",
        );
      },
    );
  });

  it("shows the captured body and Copy immediately when a reloaded document is unavailable", async () => {
    const copyText = vi.fn(async () => {});
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[protectedChange("sweep")]}
        navigateToChange={vi.fn(async () => ({ kind: "unavailable" as const }))}
        anchorUnavailable
        copyText={copyText}
      />,
      async () => {
        expect(document.body.textContent).toContain("The writer's exact words.");
        expect(document.body.textContent).not.toContain("Restore");
        await click("Copy");
        expect(copyText).toHaveBeenCalledWith("The writer's exact words.");
      },
    );
  });

  it("reloads a committed intent as a resumable action", async () => {
    const change = protectedChange("sweep");
    change.navigation = { kind: "unavailable", reason: "original anchor no longer needed" };
    change.forwardActions = {
      restore: { status: "committed", update: "update", expectedLiveStateHash: "state" },
    };
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[change]}
        navigateToChange={vi.fn(async () => ({ kind: "shown" as const }))}
      />,
      async () => {
        expect(button("Restore").disabled).toBe(false);
        expect(document.body.textContent).not.toContain("Restored");
      },
    );
  });

  it("reloads an applied intent as completed without another mutation affordance", async () => {
    const change = protectedChange("sweep");
    change.forwardActions = { restore: { status: "applied", updateId: 42 } };
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[change]}
        navigateToChange={vi.fn(async () => ({ kind: "shown" as const }))}
      />,
      async () => {
        expect(document.body.textContent).toContain("Restored");
        expect(
          [...document.querySelectorAll("button")].some((item) => item.textContent === "Restore"),
        ).toBe(false);
      },
    );
  });

  it.each([
    "anchor_unavailable",
    "retry_exhausted",
  ] as const)("reloads settled/%s as Copy-only", async (outcome) => {
    const copyText = vi.fn(async () => {});
    const change = protectedChange("sweep");
    change.forwardActions = { restore: { status: "settled", outcome } };
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[change]}
        navigateToChange={vi.fn(async () => ({ kind: "shown" as const }))}
        copyText={copyText}
      />,
      async () => {
        expect(document.body.textContent).not.toContain("Restore");
        await click("Copy");
        expect(copyText).toHaveBeenCalledWith("The writer's exact words.");
      },
    );
  });

  it("shows an ordinary captured before-body after permanent document deletion", async () => {
    const copyText = vi.fn(async () => {});
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId={g8OrdinaryDocument.trailId}
        documentId={g8OrdinaryDocument.documentId}
        changes={g8OrdinaryDocument.changes}
        navigateToChange={vi.fn(async () => ({ kind: "unavailable" as const }))}
        anchorUnavailable
        copyText={copyText}
      />,
      async () => {
        expect(document.body.textContent).toContain(
          "G8 S10 CAPTURED ORDINARY BODY: quiet dragons guarded the western gate.",
        );
        expect(document.body.textContent).not.toContain("g8-s10-before|");
        await click("Copy");
        expect(copyText).toHaveBeenCalledWith(
          "G8 S10 CAPTURED ORDINARY BODY: quiet dragons guarded the western gate.",
        );
      },
    );
  });

  it("renders the resurrection warning and idempotent Delete again", async () => {
    const runAction = vi.fn(async () => ({ status: "already_applied" as const }));
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[protectedChange("resurrection")]}
        navigateToChange={vi.fn(async () => ({ kind: "shown" as const }))}
        runAction={runAction}
      />,
      async () => {
        expect(document.body.textContent).toContain("↻ AI brought back text you deleted");
        await click("Delete again");
        expect(document.body.textContent).toContain("Deleted again");
        expect(
          [...document.querySelectorAll("button")].some(
            (item) => item.textContent === "Delete again",
          ),
        ).toBe(false);
        expect(runAction).toHaveBeenCalledTimes(1);
      },
    );
  });
});
