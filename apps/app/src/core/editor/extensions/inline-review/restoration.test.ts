// @vitest-environment jsdom
/** Undo sends anchored claims with the physical copies, without borrowing the AI client. */
import { RESTORATION_CLAIMS_TYPE } from "@meridian/prosemirror-schema";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createReviewEditor,
  destroyReviewEditors,
  posOf,
} from "@/test-support/inline-review-editor";

afterEach(destroyReviewEditors);

it("Undo atomically carries restoration claims, and Redo keeps the chain", () => {
  const { editor, doc } = createReviewEditor(["The serpent waits."]);
  const originalClient = [...doc.store.clients.keys()][0];
  const restored = new Y.Doc({ gc: false });
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
  const updates: Uint8Array[] = [];
  doc.on("update", (update) => updates.push(update));
  const from = posOf(editor, "serpent");
  editor.commands.deleteRange({ from, to: from + 7 });
  updates.length = 0;
  editor.commands.undo();
  expect(editor.getText()).toContain("serpent");
  expect(doc.getMap(RESTORATION_CLAIMS_TYPE).size).toBe(1);
  Y.applyUpdate(restored, updates[0]);
  expect(restored.getMap(RESTORATION_CLAIMS_TYPE).size).toBe(1);
  const alias = [
    ...doc.getMap<{ source: Y.ID; target: Y.ID }>(RESTORATION_CLAIMS_TYPE).values(),
  ][0];
  expect(alias.source.client).toBe(originalClient);
  expect(alias.target.client).toBe(doc.clientID);
  editor.commands.redo();
  expect(editor.getText()).not.toContain("serpent");
  editor.commands.undo();
  expect(doc.getMap(RESTORATION_CLAIMS_TYPE).size).toBe(2);
  restored.destroy();
});
