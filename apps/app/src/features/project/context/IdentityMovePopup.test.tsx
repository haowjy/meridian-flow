import { act, type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";
import { IdentityMovePopup } from "./IdentityMovePopup";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...subs: unknown[]) =>
    strings.raw.map((part, index) => part + (subs[index] ?? "")).join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
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

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <IdentityMovePopup
      projectId="project-1"
      activeThreadId={null}
      defaultWorkId={null}
      location={{
        scheme: "manuscript",
        parentPath: "/",
        folders: [],
        leaf: "chapter.md",
        provisional: false,
        editable: true,
        path: "/chapter.md",
      }}
      open={open}
      onOpenChange={setOpen}
      commit={vi.fn()}
      onOpenExisting={() => {}}
      trigger={
        <button type="button" onClick={() => setOpen(true)}>
          Rename
        </button>
      }
    />
  );
}

describe("IdentityMovePopup keyboard entry", () => {
  it("focuses the first browser row after opening from the chip", async () => {
    await withReactRoot(<Host />, async () => {
      window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
      window.cancelAnimationFrame = (frame) => window.clearTimeout(frame);
      await act(async () => {
        document.querySelector<HTMLButtonElement>("button")?.click();
      });
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Enclosing folder");
    });
  });
});
