import type { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import { type KeymapContribution, mergeKeymapContributions } from "./keymap";

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

  it("refuses Escape: the walk-home chain owns it, not a surface", () => {
    expect(() =>
      mergeKeymapContributions([
        { id: "diagram-dialog", scope: "layer", bindings: { Escape: () => true } },
      ]),
    ).toThrow(/Esc chain owns it/);
  });
});
