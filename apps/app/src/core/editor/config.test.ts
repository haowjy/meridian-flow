/** Editor configuration contracts at live-versus-review composition boundaries. */

import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "./config";

describe("createEditorConfig", () => {
  it("keeps draft review read-only even when its host requests an editable editor", () => {
    const document = new Y.Doc();

    const config = createEditorConfig({
      document,
      awareness: new Awareness(document),
      editable: true,
      enableDraftInlineReview: true,
    });

    expect(config.editable).toBe(false);
  });
});
