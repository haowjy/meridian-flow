// @vitest-environment jsdom
/** Where an input's suggestion menu hangs. */
import { describe, expect, it, vi } from "vitest";

import { createDomInputSuggestionTransport } from "./dom-input-suggestion-transport";
import type { SuggestionDriverFrame } from "./suggestion-driver";

function transport(anchorRect?: () => DOMRect | null) {
  const input = document.createElement("input");
  document.body.append(input);
  input.value = "Lin";
  input.focus();
  input.setSelectionRange(3, 3);
  const frames: SuggestionDriverFrame<never>[] = [];
  const driver = {
    menu: { subscribe: () => () => {}, snapshot: () => ({ open: false }) },
    start: vi.fn((frame: SuggestionDriverFrame<never>) => frames.push(frame)),
    update: vi.fn(),
    exit: vi.fn(),
  };
  const created = createDomInputSuggestionTransport({
    input,
    driver: driver as never,
    suggestionHost: { register: vi.fn() } as never,
    hostLeaseId: "test",
    match: ({ value }) => ({
      query: value,
      text: value,
      triggerRange: { from: 0, to: value.length },
    }),
    ...(anchorRect ? { anchorRect } : {}),
  });
  created.sync();
  return { frames, input, destroy: created.destroy };
}

describe("createDomInputSuggestionTransport", () => {
  it("hangs the menu where the host anchors it", () => {
    const below = new DOMRect(10, 20, 300, 160);
    const { frames, destroy } = transport(() => below);
    expect(frames[0]?.anchorRect()).toBe(below);
    destroy();
  });

  it("hangs the menu at the caret by default", () => {
    const { frames, input, destroy } = transport();
    const rect = frames[0]?.anchorRect();
    expect(rect).toBeInstanceOf(DOMRect);
    expect(rect?.width).toBe(0);
    destroy();
    input.remove();
  });
});
