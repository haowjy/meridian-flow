import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { Decoration, type EditorView } from "@codemirror/view";
import {
  buildComposerClipboardPayload,
  insertComposerClipboardPayload,
} from "@/features/threads/composer/clipboardInterop";
import {
  ORC,
  buildInitialState,
  inlineElementsField,
  type ReferenceElementData,
} from "@/features/threads/composer/inlineElements";
import {
  MERIDIAN_CLIPBOARD_KIND,
  MERIDIAN_CLIPBOARD_VERSION,
  type MeridianClipboardPayload,
} from "@/core/lib/meridianClipboard";

function createReference(): ReferenceElementData {
  return {
    type: "reference",
    documentId: "doc-1",
    refType: "document",
    displayName: "Chapter 1",
    documentPath: "book/chapter-1.md",
  };
}

describe("composer clipboard interop", () => {
  it("builds payload from selection and re-inserts with inline element effects", () => {
    const reference = createReference();
    const initial = buildInitialState("Hello world", [
      { position: 6, data: reference },
    ]);

    const state = EditorState.create({
      doc: initial.text,
      selection: { anchor: 0, head: initial.text.length },
      extensions: [
        inlineElementsField.init(() =>
          initial.decorations.length > 0
            ? Decoration.set(initial.decorations, true)
            : Decoration.none,
        ),
      ],
    });

    const payload = buildComposerClipboardPayload(state, 0, state.doc.length);
    expect(payload).not.toBeNull();
    if (!payload) return;

    expect(payload.kind).toBe(MERIDIAN_CLIPBOARD_KIND);
    expect(payload.version).toBe(MERIDIAN_CLIPBOARD_VERSION);
    expect(payload.text).toContain(ORC);
    expect(payload.elements).toHaveLength(1);
    expect(payload.elements[0]?.element).toMatchObject(reference);

    const dispatch = vi.fn();
    const view = { dispatch } as unknown as EditorView;
    const inserted = insertComposerClipboardPayload(view, payload, 2, 4);
    expect(inserted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const transaction = dispatch.mock.calls[0]?.[0] as
      | {
          changes: { from: number; to: number; insert: string };
          effects: Array<{
            value: { from: number; to: number; data: unknown };
          }>;
        }
      | undefined;
    expect(transaction?.changes.from).toBe(2);
    expect(transaction?.changes.to).toBe(4);
    expect(transaction?.changes.insert).toContain(ORC);
    expect(transaction?.effects).toHaveLength(1);
    expect(transaction?.effects[0]?.value.data).toMatchObject(reference);
  });

  it("ignores payloads with unsupported element types", () => {
    const payload: MeridianClipboardPayload = {
      kind: MERIDIAN_CLIPBOARD_KIND,
      version: MERIDIAN_CLIPBOARD_VERSION,
      text: `x${ORC}y`,
      elements: [
        {
          position: 1,
          element: { type: "future-embed", embedId: "e-1" },
        },
      ],
    };

    const dispatch = vi.fn();
    const view = { dispatch } as unknown as EditorView;
    const inserted = insertComposerClipboardPayload(view, payload, 0, 0);

    expect(inserted).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
