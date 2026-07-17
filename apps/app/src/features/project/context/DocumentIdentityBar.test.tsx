import { act, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...subs: unknown[]) =>
    strings.raw.map((part, index) => part + (subs[index] ?? "")).join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverAnchor: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./file-suggestions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./file-suggestions")>();
  return {
    ...actual,
    useFileSuggestions: () => ({ suggestions: [], isFetching: false, isError: false }),
  };
});
vi.mock("./untitled-reconciler-browser", () => ({
  clearQueuedIdentityFailure: vi.fn(),
  useQueuedIdentityFailure: () => null,
  useUntitledPendingSince: () => null,
}));
vi.mock("./use-identity-commit", () => ({
  useIdentityCommit: () => vi.fn(),
}));
const { DocumentIdentityBar } = await import("./DocumentIdentityBar");
const graduatedTab: ContextTab = {
  kind: "tracked",
  documentId: "doc-tracked",
  scheme: "manuscript",
  path: "/Act 1/chapter-1.md",
  name: "chapter-1.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

describe("DocumentIdentityBar affordances", () => {
  it("opens the inline identity field from a graduated Rename chip", async () => {
    await withReactRoot(
      <DocumentIdentityBar
        projectId="project-1"
        activeThreadId={null}
        defaultWorkId={null}
        tab={graduatedTab}
        onCommitted={() => {}}
        onOpenExisting={() => {}}
      />,
      async () => {
        expect(document.querySelector('input[aria-label="Document name and location"]')).toBeNull();
        const chip = findButton("Rename");
        await act(async () => chip.click());
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Document name and location"]',
        );
        expect(input?.value).toBe("chapter-1.md");
        expect(input?.selectionStart).toBe(0);
        expect(input?.selectionEnd).toBe("chapter-1.md".length);
      },
    );
  });
});

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`missing ${label} button`);
  return button;
}
