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
  swept: null,
  writerProtection: {
    kind: "sweep",
    body: { status: "available", markdown: "Writer text." },
  },
  forwardActions: {
    restore: { status: "settled", outcome: "retry_exhausted" },
  },
  reversible: false,
};
const activeChange: TrailChange = { ...settledChange, forwardActions: undefined };
let currentChange = settledChange;

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
          data: { thread: { title: "Agent thread" }, turns: [] },
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
  });

  it("offers Copy instead of another Restore after retry exhaustion", async () => {
    await withReactRoot(<PeerMarkPopover target={target()} onOpenChange={vi.fn()} />, () => {
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
      expect(buttonLabels()).toContain("Copy");
      expect(buttonLabels()).not.toContain("Restore");
    });
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
