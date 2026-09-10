// @vitest-environment jsdom
/** Literal whitespace exits the real @ lane rather than only hiding its renderer. */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it, vi } from "vitest";
import { emptyCatalogView } from "@/client/query/context-catalog-cache";
import { AtReferenceExtension, getAtReferenceMenu } from "./AtReferenceExtension";

it("closes on @ Space, stays closed through cache updates and caret re-entry, and rearms on deletion", async () => {
  const scope = { kind: "project" as const, projectId: "project" };
  const view = { ...emptyCatalogView(scope), generation: "settled" };
  const listeners = new Set<() => void>();
  const release = vi.fn();
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit,
      AtReferenceExtension.configure({
        catalog: () => ({
          label: "References",
          openContext: () => ({ warmScopes: [scope] }),
          port: {
            read: () => view,
            status: () => "ready",
            acquire: async () => view,
            subscribe: (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        }),
        suggestionHost: () => ({ register: () => ({ release }) }),
      }),
    ],
  });
  const type = async (value: string) => {
    editor.commands.insertContent(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  try {
    await type("@");
    expect(getAtReferenceMenu(editor)?.snapshot().open).toBe(true);
    expect(listeners.size).toBe(1);
    const queuedRefresh = [...listeners][0];
    await type(" ");
    expect(editor.getText()).toBe("@ ");
    expect(editor.state.selection.from).toBe(3);
    expect(getAtReferenceMenu(editor)?.snapshot().open).toBe(false);
    expect(listeners.size).toBe(0);
    expect(release).toHaveBeenCalledOnce();

    queuedRefresh?.();
    editor.commands.setTextSelection(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getAtReferenceMenu(editor)?.snapshot().open).toBe(false);
    editor.commands.setTextSelection(3);
    await type("ordinary prose");
    expect(editor.getText()).toBe("@ ordinary prose");
    expect(getAtReferenceMenu(editor)?.snapshot().open).toBe(false);

    editor.commands.deleteRange({ from: 2, to: editor.state.doc.content.size - 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.getText()).toBe("@");
    expect(getAtReferenceMenu(editor)?.snapshot().open).toBe(true);
    await type("Chapter One");
    expect(getAtReferenceMenu(editor)?.snapshot().query).toBe("Chapter One");
    expect(getAtReferenceMenu(editor)?.snapshot().open).toBe(true);
  } finally {
    editor.destroy();
  }
});
