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
        button("Restore").click();
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
        button("Delete again").click();
        expect(runAction).toHaveBeenCalledTimes(1);
      },
    );
  });
});
