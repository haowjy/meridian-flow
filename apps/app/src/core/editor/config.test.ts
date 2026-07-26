/** Editor configuration contracts at live-versus-review composition boundaries. */

import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "./config";

describe("createEditorConfig", () => {
  it("keeps a draft review editor editable — the writer is one more peer in the draft room", () => {
    const document = new Y.Doc();

    const config = createEditorConfig({
      document,
      awareness: new Awareness(document),
      editable: true,
      enableDraftInlineReview: true,
    });

    expect(config.editable).toBe(true);
  });
});
