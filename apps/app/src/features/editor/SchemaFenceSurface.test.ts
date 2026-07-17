// @vitest-environment jsdom
/** Schema-fence preview contract: isolated clone, valid-subset rendering, read-only editor. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";
import { cloneDocumentForSchemaFencePreview } from "@/core/editor/schema-fence";
import { createSchemaFencePreviewConfig } from "./SchemaFenceSurface";

let editor: Editor | null = null;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  if (editor && !editor.isDestroyed) editor.destroy();
  editor = null;
  vi.unstubAllGlobals();
});

describe("schema fence preview", () => {
  it("renders the valid subset read-only without repairing the shared document", () => {
    const source = createCollabYDoc();
    const fragment = source.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const paragraph = new Y.XmlElement("paragraph");
    const keptText = new Y.XmlText();
    const futureNode = new Y.XmlElement("sidebar");
    const futureText = new Y.XmlText();
    source.transact(() => {
      fragment.insert(0, [paragraph, futureNode]);
      paragraph.insert(0, [keptText]);
      keptText.insert(0, "Kept chapter prose");
      futureNode.insert(0, [futureText]);
      futureText.insert(0, "Unsupported future prose");
    });
    const sourceBefore = fragment.toString();
    const previewDocument = cloneDocumentForSchemaFencePreview(source);

    editor = new Editor({
      element: document.createElement("div"),
      ...createSchemaFencePreviewConfig({
        document: previewDocument,
        schemaType: "document",
        documentId: "document-preview",
      }),
    });

    expect(editor.isEditable).toBe(false);
    expect(editor.getText()).toContain("Kept chapter prose");
    expect(editor.getText()).not.toContain("Unsupported future prose");
    expect(fragment.toString()).toBe(sourceBefore);
    expect(fragment.toString()).toContain("sidebar");

    editor.destroy();
    editor = null;
    previewDocument.destroy();
    source.destroy();
  });
});
