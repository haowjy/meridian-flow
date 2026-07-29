import type { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import {
  assertKeymapContribution,
  type KeymapContribution,
  mergeKeymapContributions,
} from "./keymap";

const state = {} as EditorState;

function contribution(
  id: string,
  scope: KeymapContribution["scope"],
  handled: boolean,
): KeymapContribution & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(() => handled);
  return { id, scope, bindings: { "Alt-ArrowUp": run }, run };
}

describe("mergeKeymapContributions", () => {
  it("gives the key to the deepest owner first (law 4)", () => {
    const layer = contribution("slash", "layer", true);
    const table = contribution("table", "table", true);
    const merged = mergeKeymapContributions([table, layer]);

    expect(merged["Alt-ArrowUp"](state)).toBe(true);
    expect(layer.run).toHaveBeenCalledOnce();
    expect(table.run).not.toHaveBeenCalled();
  });

  it("hands the key down when the deeper owner declines", () => {
    const object = contribution("object", "object", false);
    const document = contribution("blocks", "document", true);
    const merged = mergeKeymapContributions([document, object]);

    expect(merged["Alt-ArrowUp"](state)).toBe(true);
    expect(object.run).toHaveBeenCalledOnce();
    expect(document.run).toHaveBeenCalledOnce();
  });

  it("reports the key unhandled when nobody takes it", () => {
    const merged = mergeKeymapContributions([contribution("table", "table", false)]);
    expect(merged["Alt-ArrowUp"](state)).toBe(false);
  });
});

describe("assertKeymapContribution", () => {
  it("refuses Escape: the walk-home chain owns it, not a surface", () => {
    expect(() =>
      assertKeymapContribution({
        id: "diagram-dialog",
        scope: "layer",
        bindings: { Escape: () => true },
      }),
    ).toThrow(/Esc chain owns it/);
  });

  it("names the lane, so the refusal reaches whoever wrote the binding", () => {
    expect(() =>
      assertKeymapContribution({
        id: "slash-menu",
        scope: "layer",
        bindings: { Escape: () => true },
      }),
    ).toThrow(/"slash-menu"/);
  });

  it("passes anything else through", () => {
    expect(() =>
      assertKeymapContribution({
        id: "table",
        scope: "table",
        bindings: { "Alt-ArrowUp": () => true },
      }),
    ).not.toThrow();
  });
});
