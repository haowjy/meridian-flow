// @vitest-environment jsdom
/** Typing in a settled search stays in the field; only the settled value reaches its owner. */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { SettledSearchField } from "./SearchField";

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("keeps keystrokes local and reports the trimmed text once typing settles", async () => {
  vi.useFakeTimers();
  const onSettle = vi.fn();
  let ownerRenders = 0;
  function Owner() {
    ownerRenders += 1;
    return <SettledSearchField label="Search chats" value={null} onSettle={onSettle} />;
  }
  try {
    await withReactRoot(<Owner />, async () => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search chats"]');
      if (!input) throw new Error("Search field did not render");
      const rendersBefore = ownerRenders;
      onSettle.mockClear();
      act(() => type(input, "arc"));
      act(() => type(input, "arc 3 "));
      expect(input.value).toBe("arc 3 ");
      expect(ownerRenders).toBe(rendersBefore);
      expect(onSettle).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(200));
      expect(onSettle).toHaveBeenCalledExactlyOnceWith("arc 3");
    });
  } finally {
    vi.useRealTimers();
  }
});
