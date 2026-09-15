/** Creation eligibility follows visible editor content rather than Yjs container presence. */

import { expect, it } from "vitest";
import * as Y from "yjs";
import { resourceDocumentIsEmpty } from "./resource-document-eligibility";

function fragmentWith(...children: Array<Y.XmlElement | Y.XmlText>): Y.XmlFragment {
  const document = new Y.Doc();
  const fragment = document.getXmlFragment("default");
  fragment.push(children);
  return fragment;
}

it("treats empty document structure as empty", () => {
  expect(resourceDocumentIsEmpty(fragmentWith())).toBe(true);
  expect(resourceDocumentIsEmpty(fragmentWith(new Y.XmlElement("paragraph")))).toBe(true);

  const wrapper = new Y.XmlElement("doc");
  wrapper.push([new Y.XmlElement("heading"), new Y.XmlElement("paragraph")]);
  expect(resourceDocumentIsEmpty(fragmentWith(wrapper))).toBe(true);
});

it("treats text and atom nodes as creation-worthy content", () => {
  const text = new Y.XmlText();
  text.insert(0, "words");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.push([text]);
  expect(resourceDocumentIsEmpty(fragmentWith(paragraph))).toBe(false);

  expect(resourceDocumentIsEmpty(fragmentWith(new Y.XmlElement("image")))).toBe(false);
});
