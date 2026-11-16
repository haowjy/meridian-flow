// @vitest-environment jsdom
/**
 * Probe: two writers type into one paragraph at once, one key at a time, with each side's updates
 * arriving a few keys late. Each side's word must stay whole and in order, and both documents agree.
 * It fails when the binding puts the local cursor back at a stale offset after a remote update
 * (see concurrent-typing.md beside this file).
 */
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "@/core/editor/config";
import { DocumentHistory } from "@/core/editor/editor-history";
import { createLocalPresence } from "@/core/editor/local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";

const editors: Editor[] = [];
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  for (const e of editors.splice(0)) if (!e.isDestroyed) e.destroy();
  vi.unstubAllGlobals();
});

function mount(doc: Y.Doc) {
  const e = new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({
      document: doc,
      history: DocumentHistory.forDocument(doc),
      presence: createLocalPresence(new Awareness(doc)),
      showCollaborationDecorations: false,
    }),
  });
  editors.push(e);
  return e;
}

function run(delay: number) {
  const seed = new Y.Doc({ gc: false });
  seed.clientID = 1;
  const p = new Y.XmlElement("paragraph");
  p.setAttribute("id", "seed");
  const t = new Y.XmlText();
  p.insert(0, [t]);
  t.insert(0, "Start ");
  seed.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [p]);
  const base = Y.encodeStateAsUpdate(seed);
  const docs = [2, 3].map((id) => {
    const d = new Y.Doc({ gc: false });
    d.clientID = id;
    Y.applyUpdate(d, base);
    return d;
  });
  const eds = docs.map(mount);
  const out: Uint8Array[][] = [[], []];
  docs.forEach((d, i) =>
    d.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "net") out[i]!.push(u);
    }),
  );
  const flush = () => {
    for (const i of [0, 1]) for (const u of out[i]!.splice(0)) Y.applyUpdate(docs[1 - i]!, u, "net");
  };
  eds.forEach((e) => {
    const end = e.state.doc.content.size - 1;
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, end)));
  });
  const words = ["Alpha ", "Bravo "];
  for (let k = 0; k < 6; k++) {
    eds.forEach((e, i) => e.view.dispatch(e.state.tr.insertText(words[i]![k]!)));
    if ((k + 1) % delay === 0) flush();
  }
  flush();
  return eds.map((e) => e.state.doc.textContent);
}

for (const delay of [1, 2, 3, 6]) {
  it(`keeps each writer's word whole when updates arrive every ${delay} keys`, () => {
    const [a, b] = run(delay);
    expect(a).toBe(b);
    expect(a).toMatch(/^Start (Alpha Bravo|Bravo Alpha) $/);
  });
}
