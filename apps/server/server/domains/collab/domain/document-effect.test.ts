/** Complete-effect equality must not confuse presentation or history with content. */
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { documentEffectsEqual } from "./document-effect.js";

it.each([
  "marks",
  "attributes",
  "type",
  "structure",
  "text",
])("detects changed %s independently of review coverage", (effect) => {
  const live = createCollabYDoc({ gc: false });
  const draft = createCollabYDoc({ gc: false });
  try {
    const block = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Alpha");
    block.insert(0, [text]);
    live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [block]);
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(live));
    const fragment = draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const changed = fragment.get(0) as Y.XmlElement;
    const changedText = changed.get(0) as Y.XmlText;
    expect(documentEffectsEqual(live, draft)).toBe(true);
    if (effect === "marks") changedText.format(0, 5, { strong: {} });
    if (effect === "attributes") changed.setAttribute("level", "2");
    if (effect === "text") changedText.insert(5, "!");
    if (effect === "structure") fragment.insert(1, [new Y.XmlElement("paragraph")]);
    if (effect === "type") {
      fragment.delete(0, 1);
      const heading = new Y.XmlElement("heading");
      const headingText = new Y.XmlText();
      headingText.insert(0, "Alpha");
      heading.insert(0, [headingText]);
      fragment.insert(0, [heading]);
    }
    expect(documentEffectsEqual(live, draft)).toBe(false);
  } finally {
    live.destroy();
    draft.destroy();
  }
});

it("ignores cancelled history and independent Yjs identities", () => {
  const live = createCollabYDoc({ gc: false });
  const draft = createCollabYDoc({ gc: false });
  try {
    for (const doc of [live, draft]) {
      const block = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Alpha");
      block.insert(0, [text]);
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [block]);
    }
    const text = (draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    text.insert(5, "!");
    text.delete(5, 1);
    expect(documentEffectsEqual(live, draft)).toBe(true);
  } finally {
    live.destroy();
    draft.destroy();
  }
});
