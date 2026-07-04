import { createRequire } from "node:module";
import type { ReviewOperation } from "@meridian/contracts/drafts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OrderedOperation } from "./DraftReviewSidebar";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html: string,
  ) => {
    window: Window & typeof globalThis & { close: () => void };
  };
};

const { AcceptConfirmContent, OperationCard, operationNeedsAcceptConfirm } = await import(
  "./DraftReviewSidebar"
);

function operation(input: Partial<ReviewOperation> & { operationId: string }): ReviewOperation {
  return {
    rejectSourceUpdateIds: [],
    kind: "agent",
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
    ...input,
  };
}

function entry(op: ReviewOperation, input: Partial<OrderedOperation> = {}): OrderedOperation {
  return {
    operation: op,
    hunks: [],
    firstPos: 1,
    shape: "insert",
    hasOwnDeletion: false,
    includesWriterEdits: false,
    ...input,
  };
}

function operationCard(overrides: Partial<React.ComponentProps<typeof OperationCard>> = {}) {
  return (
    <OperationCard
      entry={entry(operation({ operationId: "op-card" }))}
      active={false}
      pending={false}
      dead={false}
      acceptAvailable={true}
      discardAvailable={true}
      confirmingAccept={false}
      confirmingDiscard={false}
      needsAcceptConfirm={false}
      needsOverlapConfirm={false}
      needsDiscardConfirm={false}
      acceptClosureEntries={[]}
      rejectClosureEntries={[]}
      onSelect={() => undefined}
      onConfirmAccept={() => undefined}
      onCancelAccept={() => undefined}
      onAccept={() => undefined}
      onConfirmDiscard={() => undefined}
      onCancelDiscard={() => undefined}
      onDiscard={() => undefined}
      {...overrides}
    />
  );
}

describe("DraftReviewSidebar accept confirmation", () => {
  it("renders a terminal cannot-place card with copyable content and only discard available", () => {
    const html = renderToStaticMarkup(
      <OperationCard
        entry={
          {
            ...entry(operation({ operationId: "op-dead" })),
            hunks: [
              {
                hunkId: "h-dead",
                operationIds: ["op-dead"],
                range: {
                  from: 10,
                  to: 54,
                  hasDeletion: false,
                  insertedTextByOperation: new Map([
                    ["op-dead", "The jade phoenix landed on the ruined wall."],
                  ]),
                },
                hasDeletion: false,
                insertedTextByOperation: new Map([
                  ["op-dead", "The jade phoenix landed on the ruined wall."],
                ]),
              },
            ],
          } as OrderedOperation
        }
        active={false}
        pending={false}
        dead={true}
        acceptAvailable={true}
        discardAvailable={true}
        confirmingAccept={false}
        confirmingDiscard={false}
        needsAcceptConfirm={false}
        needsOverlapConfirm={false}
        needsDiscardConfirm={false}
        acceptClosureEntries={[]}
        rejectClosureEntries={[]}
        onSelect={() => undefined}
        onConfirmAccept={() => undefined}
        onCancelAccept={() => undefined}
        onAccept={() => undefined}
        onConfirmDiscard={() => undefined}
        onCancelDiscard={() => undefined}
        onDiscard={() => undefined}
      />,
    );

    expect(html).toContain("placed automatically");
    expect(html).toContain("Can&#x27;t place");
    expect(html).toContain("Copy");
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("The jade phoenix landed on the ruined wall.");
    expect(html).toContain("Discard");
    expect(html).not.toContain("Accept");
  });

  it("renders dead-card discard confirmation before firing destructive discard", () => {
    const onConfirmDiscard = vi.fn();
    const onDiscard = vi.fn();

    const firstClickHtml = renderToStaticMarkup(
      operationCard({
        dead: true,
        needsDiscardConfirm: true,
        onConfirmDiscard,
        onDiscard,
      }),
    );
    expect(firstClickHtml).not.toContain("This also removes your edits in this passage.");

    const confirmingHtml = renderToStaticMarkup(
      operationCard({
        dead: true,
        confirmingDiscard: true,
        needsDiscardConfirm: true,
        onConfirmDiscard,
        onDiscard,
      }),
    );
    expect(confirmingHtml).toContain("This also removes your edits in this passage.");
    expect(confirmingHtml).toContain("Keep");
  });

  it("dead-card confirm discard reaches onDiscard", () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    try {
      const onDiscard = vi.fn();
      const rootNode = dom.window.document.getElementById("root");
      if (!rootNode) throw new Error("missing root");
      const root = createRoot(rootNode);
      act(() => {
        root.render(
          operationCard({
            dead: true,
            confirmingDiscard: true,
            needsDiscardConfirm: true,
            onDiscard,
          }),
        );
      });

      const discardButtons = Array.from(rootNode.querySelectorAll("button")).filter(
        (button): button is HTMLButtonElement => button.textContent === "Discard",
      );
      act(() => {
        discardButtons.at(-1)?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(onDiscard).toHaveBeenCalledTimes(1);
      act(() => root.unmount());
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      dom.window.close();
    }
  });

  it("does not present truncated excerpts as copyable dead-card text", () => {
    const html = renderToStaticMarkup(
      operationCard({
        entry: entry(
          operation({
            operationId: "op-dead-no-hunk-text",
            afterExcerpt: "A victorious swordsman strode through the crimson courtyard…",
          }),
        ),
        dead: true,
      }),
    );

    expect(html).toContain("Discard this proposal");
    expect(html).not.toContain("Copy the text below");
    expect(html).not.toContain("Apply the whole draft");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("Copy</button>");
  });

  it("uses resolved inserted hunk text rather than the operation excerpt for dead-card copy", () => {
    const fullProposal =
      "A victorious swordsman strode through the crimson courtyard with a banner of jade fire, then knelt beside the broken gate to swear the sect's oath.";
    const html = renderToStaticMarkup(
      operationCard({
        entry: entry(
          operation({
            operationId: "op-dead-full-text",
            afterExcerpt: "A victorious swordsman strode through the crimson courtyard…",
          }),
          {
            hunks: [
              {
                hunkId: "h-full",
                operationIds: ["op-dead-full-text"],
                range: {
                  from: 1,
                  to: 140,
                  hasDeletion: false,
                  insertedTextByOperation: new Map([["op-dead-full-text", fullProposal]]),
                },
                hasDeletion: false,
                insertedTextByOperation: new Map([["op-dead-full-text", fullProposal]]),
              },
            ],
          },
        ),
        dead: true,
      }),
    );

    expect(html).toContain(
      "A victorious swordsman strode through the crimson courtyard with a banner of jade fire",
    );
    expect(html).toContain("sect&#x27;s oath");
  });

  it("keeps normal proposal actions unchanged", () => {
    const html = renderToStaticMarkup(
      <OperationCard
        entry={entry(operation({ operationId: "op-normal", afterExcerpt: "Blue flame" }))}
        active={false}
        pending={false}
        dead={false}
        acceptAvailable={true}
        discardAvailable={true}
        confirmingAccept={false}
        confirmingDiscard={false}
        needsAcceptConfirm={false}
        needsOverlapConfirm={false}
        needsDiscardConfirm={false}
        acceptClosureEntries={[]}
        rejectClosureEntries={[]}
        onSelect={() => undefined}
        onConfirmAccept={() => undefined}
        onCancelAccept={() => undefined}
        onAccept={() => undefined}
        onConfirmDiscard={() => undefined}
        onCancelDiscard={() => undefined}
        onDiscard={() => undefined}
      />,
    );

    expect(html).toContain("Accept");
    expect(html).toContain("Discard");
    expect(html).not.toContain("place automatically");
  });

  it("renders dragged proposal copy with one-line previews", () => {
    const html = renderToStaticMarkup(
      <AcceptConfirmContent
        hasOverlap={false}
        acceptClosureEntries={[
          entry(
            operation({
              operationId: "op-1",
              afterExcerpt: "Silver light filled the room.",
            }),
          ),
          entry(
            operation({
              operationId: "op-2",
              classification: "rewrite",
              contribution: "rewrote",
              beforeExcerpt: "The old oath",
              afterExcerpt: "The new vow",
            }),
          ),
        ]}
      />,
    );

    expect(html).toContain("This also accepts:");
    expect(html).toContain("Silver light filled the room.");
    expect(html).toContain("The old oath");
    expect(html).toContain("The new vow");
  });

  it("renders combined closure and overlap consequence copy", () => {
    const html = renderToStaticMarkup(
      <AcceptConfirmContent
        hasOverlap={true}
        acceptClosureEntries={[
          entry(operation({ operationId: "op-1", afterExcerpt: "Blue flame" })),
        ]}
      />,
    );

    expect(html).toContain(
      "This also accepts the related proposals and applies your latest edits in the same passage.",
    );
    expect(html).toContain("Blue flame");
  });

  it("does not require first-click confirmation for a single-operation accept", () => {
    expect(operationNeedsAcceptConfirm(operation({ operationId: "op-1" }))).toBe(false);
  });
});
