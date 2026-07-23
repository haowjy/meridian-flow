import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...subs: unknown[]) =>
    strings.raw.map((part, index) => part + (subs[index] ?? "")).join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
// The chip resolves draft state from DraftReviewProvider; identity-bar tests
// exercise the bar's own chrome, so the chip renders nothing here.
vi.mock("@/features/editor/DraftReviewChip", () => ({
  DraftReviewChip: () => null,
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
const { pendingSince } = vi.hoisted(() => ({
  pendingSince: { value: null as number | null },
}));
vi.mock("./untitled-reconciler-browser", () => ({
  clearQueuedIdentityFailure: vi.fn(),
  useQueuedIdentityFailure: () => null,
  useUntitledPendingSince: () => pendingSince.value,
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

const provisionalTab: ContextTab = {
  kind: "new",
  documentId: "doc-new",
  name: "Untitled 4",
};

function barFor(tab: ContextTab) {
  return (
    <DocumentIdentityBar
      projectId="project-1"
      activeThreadId={null}
      defaultWorkId={null}
      tab={tab}
      onCommitted={() => {}}
      onOpenExisting={() => {}}
    />
  );
}

describe("DocumentIdentityBar affordances", () => {
  afterEach(() => {
    pendingSince.value = null;
  });

  it("opens the inline identity field from a graduated Rename chip", async () => {
    await withReactRoot(barFor(graduatedTab), async () => {
      expect(document.querySelector('input[aria-label="Document name and location"]')).toBeNull();
      const chip = findButton("Rename");
      await act(async () => chip.click());
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="Document name and location"]',
      );
      expect(input?.value).toBe("chapter-1.md");
      expect(input?.selectionStart).toBe(0);
      expect(input?.selectionEnd).toBe("chapter-1.md".length);
    });
  });

  // Regression: the device-only status must never replace the placement
  // action — placement commits queue durably offline, so device-only is
  // exactly when a writer may want to file the document.
  it("shows the device-only status beside a provisional Choose a home chip", async () => {
    pendingSince.value = Date.now() - 5_000;
    await withReactRoot(barFor(provisionalTab), async () => {
      const status = document.querySelector('[role="status"]');
      expect(status?.textContent).toContain("Only on this device");
      const chip = findButton("Choose a home");
      await act(async () => chip.click());
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="Document name and location"]',
      );
      // Placement grammar: the field opens empty on a never-homed doc.
      expect(input?.value).toBe("");
      // The status keeps its place while the field is open.
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "Only on this device",
      );
    });
  });

  it("shows the device-only status beside a graduated Rename chip", async () => {
    pendingSince.value = Date.now() - 5_000;
    await withReactRoot(barFor(graduatedTab), async () => {
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "Only on this device",
      );
      expect(findButton("Rename")).toBeTruthy();
    });
  });
});

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`missing ${label} button`);
  return button;
}
