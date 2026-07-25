// @vitest-environment jsdom
/** Durable recovery fallback parity for the editor peer-mark popover. */

import type { TrailChangeV1 as TrailChange } from "@meridian/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { PeerMarkPopoverTarget } from "./PeerMarkPopover";

const settledChange: TrailChange = {
  changeId: "change-1",
  ordinal: 1,
  documentId: "document-1",
  pushId: null,
  receiptId: null,
  kind: "delete",
  beforeBlockId: null,
  afterBlockId: null,
  beforeText: "block-1|Writer text.",
  afterTextAtReceipt: null,
  navigation: { kind: "unavailable", reason: "test" },
  forwardActions: {
    restore: { status: "settled", outcome: "retry_exhausted" },
  },
  reversible: false,
};
const activeChange: TrailChange = { ...settledChange, forwardActions: undefined };
let currentChange = settledChange;
let currentThreadTitle: string | null = "Agent thread";
let currentTurns: Array<{
  id: string;
  role: string;
  blocks: Array<{ blockType: string; textContent?: string | null }>;
}> = [];

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => strings[0],
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), removeQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) =>
    queryKey[0] === "change-trail-detail"
      ? {
          data: [{ documentId: "document-1", changes: [currentChange] }],
          isPending: false,
          isError: false,
        }
      : {
          data: { thread: { title: currentThreadTitle }, turns: currentTurns },
          isPending: false,
          isError: false,
        },
}));
vi.mock("@/client/change-trails", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/client/change-trails")>();
  return {
    ...actual,
    applyTrailForwardAction: vi.fn(async () => ({ status: "retry_exhausted" as const })),
  };
});
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    observe: () => vi.fn(),
    peek: () => null,
  }),
}));

const { PeerMarkPopover } = await import("./PeerMarkPopover");

describe("PeerMarkPopover recovery", () => {
  beforeEach(() => {
    currentChange = settledChange;
    currentThreadTitle = "Agent thread";
    currentTurns = [];
  });

  it("offers Copy instead of another Restore after retry exhaustion", async () => {
    await withReactRoot(<PeerMarkPopover target={target()} onOpenChange={vi.fn()} />, async () => {
      await act(async () => button("Show details").click());
      expect(document.body.textContent).toContain("Writer text.");
      expect(buttonLabels()).toContain("Copy");
      expect(buttonLabels()).not.toContain("Restore");
    });
  });

  it("switches to Copy when the current recovery attempt exhausts retries", async () => {
    currentChange = activeChange;
    await withReactRoot(<PeerMarkPopover target={target()} onOpenChange={vi.fn()} />, async () => {
      expect(buttonLabels()).toContain("Restore");
      await act(async () => {
        button("Restore").click();
      });
      await act(async () => button("Show details").click());
      expect(buttonLabels()).toContain("Copy");
      expect(buttonLabels()).not.toContain("Restore");
    });
  });

  it("offers trail-backed Restore for an ordinary non-swept mark", async () => {
    currentChange = activeChange;
    const ordinaryTarget = target();
    ordinaryTarget.marker = { ...ordinaryTarget.marker, swept: false };

    await withReactRoot(<PeerMarkPopover target={ordinaryTarget} onOpenChange={vi.fn()} />, () => {
      expect(buttonLabels()).toContain("Restore");
    });
  });

  it("attributes an untitled thread to AI rather than a bare chat title", async () => {
    currentThreadTitle = null;
    await withReactRoot(<PeerMarkPopover target={target()} onOpenChange={vi.fn()} />, () => {
      expect(document.body.textContent).toContain("AI assistant");
    });
  });

  it("keeps long removed prose readable without a strike", async () => {
    const longPassage =
      "The archive doors opened into a corridor of ash where every footstep stirred the names of vanished kingdoms into the air.";
    currentChange = {
      ...settledChange,
      beforeText: `block-1|${longPassage}`,
    };
    await withReactRoot(<PeerMarkPopover target={target()} onOpenChange={vi.fn()} />, async () => {
      await act(async () => button("Show details").click());
      const removedText = [...document.querySelectorAll("p")].find((element) =>
        element.textContent?.includes("corridor of ash"),
      );
      expect(removedText?.className).toContain("text-prose-foreground");
      expect(removedText?.className).not.toContain("line-through");
    });
  });

  it("uses the marker's deletion anatomy for ordinary pure-deletion copy", async () => {
    currentChange = {
      ...settledChange,
      kind: "modify",
    };
    const deletionTarget = target();
    deletionTarget.marker = {
      ...deletionTarget.marker,
      kind: "modify",
      pureDeletionOffset: 4,
    };

    await withReactRoot(<PeerMarkPopover target={deletionTarget} onOpenChange={vi.fn()} />, () => {
      expect(document.body.textContent).toContain("Deleted a passage");
      expect(document.body.textContent).not.toContain("Replaced a passage");
    });
  });

  it("keeps evidence behind one disclosure and shows swept impact only when applicable", async () => {
    currentTurns = [
      {
        id: "request-turn",
        role: "user",
        blocks: [{ blockType: "text", textContent: "Tighten the opening paragraph." }],
      },
      { id: "turn-1", role: "assistant", blocks: [] },
    ];
    await withReactRoot(<PeerMarkPopover target={target()} onOpenChange={vi.fn()} />, async () => {
      expect(document.body.textContent).not.toContain("Writer text.");
      expect(document.body.textContent).not.toContain("Tighten the opening paragraph.");
      await act(async () => button("Show details").click());
      expect(document.body.textContent).toContain("Writer text.");
      expect(document.body.textContent).toContain("You asked");
      expect(document.body.textContent).toContain("Tighten the opening paragraph.");
      expect(document.body.textContent).toContain(
        "This passage included edits you made that the AI hadn't seen.",
      );
    });
  });

  it("does not show the swept sentence for an ordinary mark", async () => {
    const ordinaryTarget = target();
    ordinaryTarget.marker = { ...ordinaryTarget.marker, swept: false };
    await withReactRoot(
      <PeerMarkPopover target={ordinaryTarget} onOpenChange={vi.fn()} />,
      async () => {
        await act(async () => button("Show details").click());
        expect(document.body.textContent).not.toContain(
          "This passage included edits you made that the AI hadn't seen.",
        );
      },
    );
  });
});

function target(): PeerMarkPopoverTarget {
  return {
    marker: {
      changeId: "change-1",
      group: { trailId: "trail-1", documentId: "document-1" },
      author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
      kind: "delete",
      anchor: { type: "unresolved", raw: { kind: "unavailable", reason: "test" } },
      swept: true,
      excerpt: "Writer text.",
      pureDeletionOffset: null,
      projectionRevision: 1,
      receivedAt: Date.now(),
      dismissed: false,
    },
    element: {
      getBoundingClientRect: () => ({}) as DOMRect,
    } as HTMLElement,
    activation: "pointer",
    editorSelection: { from: 1, to: 1 },
  };
}

function buttonLabels(): string[] {
  return [...document.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button: ${label}`);
  return found as HTMLButtonElement;
}
