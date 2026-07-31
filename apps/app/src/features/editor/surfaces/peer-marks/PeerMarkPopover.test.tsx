// @vitest-environment jsdom
/** Minimal live-mark attribution, durable diff disclosure, and navigation. */

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
  beforeBlockIdentity: null,
  afterBlockIdentity: null,
  beforeText: "block-1|Writer text.",
  afterTextAtReceipt: null,
  navigation: { kind: "unavailable", reason: "test" },
};
let currentChange = settledChange;

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => strings[0],
  t: (strings: TemplateStringsArray) => strings[0],
}));
let detailPending = false;
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), removeQueries: vi.fn() }),
  queryOptions: <T,>(options: T) => options,
  useQuery: () =>
    detailPending
      ? { data: undefined, isPending: true, isError: false }
      : {
          data: [{ documentId: "document-1", changes: [currentChange] }],
          isPending: false,
          isError: false,
        },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & {
    size?: string;
    variant?: string;
  }) => <button {...props} />,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverAnchor: () => null,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    observe: () => vi.fn(),
    peek: () => null,
  }),
}));

const { PeerMarkPopover } = await import("./PeerMarkPopover");

describe("PeerMarkPopover", () => {
  beforeEach(() => {
    currentChange = settledChange;
    detailPending = false;
  });

  it("keeps the resting popover to actor, time, recovery, diff, and conversation", async () => {
    await withReactRoot(
      <PeerMarkPopover editor={null} target={target()} onOpenChange={vi.fn()} />,
      () => {
        expect(document.body.textContent).toContain("AI assistant");
        expect(buttonLabels()).toEqual(["Before / After", "Open conversation"]);
        expect(document.body.textContent).not.toContain("Deleted a passage");
        expect(document.body.textContent).not.toContain("Removed passage");
        expect(document.body.textContent).not.toContain("You asked");
        expect(document.body.textContent).not.toContain("This passage included edits");
        expect(document.body.textContent).not.toContain("Writer text.");
      },
    );
  });

  it("withholds the actions row until trail evidence resolves", async () => {
    detailPending = true;

    await withReactRoot(
      <PeerMarkPopover editor={null} target={target()} onOpenChange={vi.fn()} />,
      () => {
        expect(document.body.textContent).toContain("AI assistant");
        expect(buttonLabels()).toEqual([]);
      },
    );
  });

  it("reveals the shared trail-backed Before/After renderer", async () => {
    await withReactRoot(
      <PeerMarkPopover editor={null} target={target()} onOpenChange={vi.fn()} />,
      async () => {
        await act(async () => button("Before / After").click());
        expect(document.querySelector('[data-change-excerpt="before"]')?.textContent).toContain(
          "Writer text.",
        );
        expect(document.body.textContent).not.toContain("Copy");
      },
    );
  });

  it("keeps ordinary marks read-only", async () => {
    const ordinaryTarget = target();
    ordinaryTarget.marker = { ...ordinaryTarget.marker, swept: false };

    await withReactRoot(
      <PeerMarkPopover editor={null} target={ordinaryTarget} onOpenChange={vi.fn()} />,
      () => {
        expect(buttonLabels()).toEqual(["Before / After", "Open conversation"]);
      },
    );
  });

  it("keeps swept marks read-only", async () => {
    await withReactRoot(
      <PeerMarkPopover editor={null} target={target()} onOpenChange={vi.fn()} />,
      () => {
        expect(buttonLabels()).toEqual(["Before / After", "Open conversation"]);
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
    changeId: "change-1",
    activation: "pointer",
    editorSelection: { from: 1, to: 1, relative: null },
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
