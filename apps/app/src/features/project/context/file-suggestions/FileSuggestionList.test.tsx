/**
 * Roving-focus contract of FileSuggestionList: the arrow walk must cover
 * every `data-file-suggestion` stop inside the component — including host
 * header actions, whose only keyboard route is this walk (hosts intercept
 * Tab to exit the popover).
 */
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { FileSuggestionList } from "./FileSuggestionList";
import type { FileSuggestion } from "./file-suggestions";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...subs: unknown[]) =>
    strings.raw.map((part, index) => part + (subs[index] ?? "")).join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => children,
}));

const SUGGESTIONS: FileSuggestion[] = [
  { scheme: "manuscript", path: "/gel", name: "gel", kind: "dir", parents: [] },
  { scheme: "manuscript", path: "/chapter-1", name: "chapter-1", kind: "file", parents: [] },
];

function pressKey(target: Element, key: string, shiftKey = false) {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
}

function focused() {
  return document.activeElement as HTMLElement | null;
}

describe("FileSuggestionList", () => {
  it("walks header actions and rows as one arrow order, and Enter activates", async () => {
    const onOpenExisting = vi.fn();
    const onSelect = vi.fn();
    await withReactRoot(
      <FileSuggestionList
        header={
          <button data-file-suggestion type="button" tabIndex={-1} onClick={onOpenExisting}>
            Open existing
          </button>
        }
        suggestions={SUGGESTIONS}
        onSelect={onSelect}
        onClose={() => {}}
        hideParents
      />,
      async () => {
        const stops = Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-file-suggestion]"),
        );
        expect(stops.map((stop) => stop.textContent)).toEqual([
          "Open existing",
          "gel",
          "chapter-1",
        ]);

        // The header action leads the walk; arrows move through rows and wrap.
        stops[0]?.focus();
        pressKey(stops[0] as Element, "ArrowDown");
        expect(focused()?.textContent).toBe("gel");
        pressKey(focused() as Element, "ArrowUp");
        expect(focused()?.textContent).toBe("Open existing");
        pressKey(focused() as Element, "ArrowUp");
        expect(focused()?.textContent).toBe("chapter-1");

        // Enter on the focused header action fires its click handler.
        stops[0]?.focus();
        pressKey(stops[0] as Element, "Enter");
        expect(onOpenExisting).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
      },
    );
  });
});
