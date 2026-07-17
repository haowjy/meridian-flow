/** Writer-facing behavior checks for the provisional document rename line. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

const mocks = vi.hoisted(() => ({ getDetached: vi.fn() }));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({ getDetached: mocks.getDetached }),
}));
vi.mock("./file-suggestions", () => ({
  FileSuggestionList: () => null,
  folderChildren: () => [],
  parentPath: () => "/",
  useFileSuggestions: () => ({ suggestions: [] }),
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverAnchor: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

const { UntitledRenameLine } = await import("./UntitledRenameLine");

const trackedTab: Extract<ContextTab, { kind: "tracked" }> = {
  kind: "tracked",
  documentId: "doc-1",
  scheme: "scratch",
  workId: "5d1920c4-0000-0000-0000-000000000000",
  path: "/Untitled 4.md",
  name: "Untitled 4.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: true,
};

describe("UntitledRenameLine", () => {
  it("shows and selects only the provisional basename", async () => {
    const document = new Y.Doc();
    mocks.getDetached.mockReturnValue({
      document,
      fragmentName: "default",
    });

    await withRenameLine(trackedTab, false, async () => {
      const input = window.document.querySelector<HTMLInputElement>("input");
      expect(input?.value).toBe("Untitled 4.md");
      expect(input?.value).not.toContain("scratch://");
      expect(input?.value).not.toContain(trackedTab.workId);

      if (!input) throw new Error("rename input did not render");
      const select = vi.spyOn(input, "select");
      Object.assign(input, { attachEvent: vi.fn(), detachEvent: vi.fn() });
      await act(async () => input?.focus());
      expect(select).toHaveBeenCalledOnce();
    });
  });
});

async function withRenameLine(
  tab: Extract<ContextTab, { kind: "tracked" | "new" }>,
  deviceOnly: boolean,
  run: () => Promise<void> | void,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <UntitledRenameLine
        projectId="project-1"
        activeThreadId={null}
        tab={tab}
        deviceOnly={deviceOnly}
        onRenamed={vi.fn()}
        onOpenExisting={vi.fn()}
      />
    </QueryClientProvider>,
    run,
  );
}
