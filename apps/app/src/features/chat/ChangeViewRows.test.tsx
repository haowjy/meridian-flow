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
        expect(document.body.textContent).toContain(
          "Removed a passage that included words the agent hadn't seen.",
        );
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
        await click("Copy");
        expect(copyText).toHaveBeenCalledWith("The writer's exact words.");
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
    const change = {
      ...protectedChange("sweep"),
      kind: "modify" as const,
      beforeText: "display-hash|S10 captured before deletion.",
      writerProtection: undefined,
    };
    await withReactRoot(
      <ChangeViewRows
        threadId="thread-1"
        trailId="trail-1"
        documentId="document-1"
        changes={[change]}
        navigateToChange={vi.fn(async () => ({ kind: "unavailable" as const }))}
        anchorUnavailable
        copyText={copyText}
      />,
      async () => {
        expect(document.body.textContent).toContain("S10 captured before deletion.");
        expect(document.body.textContent).not.toContain("display-hash|");
        await click("Copy");
        expect(copyText).toHaveBeenCalledWith("S10 captured before deletion.");
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
        expect(document.body.textContent).toContain(
          "↻ This edit brought back text you had deleted",
        );
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
