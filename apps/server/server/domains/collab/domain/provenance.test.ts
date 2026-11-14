/** Contract tests for deterministic provenance replay and the reserved namespace.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Provenance locator and materialization algorithm
 */

import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendProvenanceFacts, type DocumentAuthorityId } from "./provenance.js";

const _authorityId = "00000000-0000-4000-8000-000000000100" as DocumentAuthorityId;

describe("provenance materialization", () => {
  it("accepts idempotent facts and blocks conflicting append-only assignments", () => {
    const doc = proseDoc("ab");
    const target = textRange(doc);
    const first = { version: 1 as const, target, root: target };
    expect(() => appendProvenanceFacts(doc, { targets: [first, first] })).not.toThrow();
    expect(() =>
      appendProvenanceFacts(doc, {
        targets: [
          {
            version: 1,
            target,
            root: { clientID: target.clientID + 1, clock: 0, length: target.length },
          },
        ],
      }),
    ).toThrow(/Conflicting append-only target assignment/);
  });

  it("blocks divergent restoration of one root unit to two visible targets", () => {
    const doc = proseDoc("a");
    const root = textRange(doc);
    const first = appendVisibleText(doc, "b");
    const second = appendVisibleText(doc, "c");

    expect(() =>
      appendProvenanceFacts(doc, {
        targets: [
          { version: 1, target: first, root },
          { version: 1, target: second, root },
        ],
      }),
    ).toThrow("One provenance root unit cannot have two visible targets");
  });
});

function proseDoc(value: string): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.push([new Y.XmlText(value)]);
  doc.getXmlFragment("prosemirror").push([paragraph]);
  return doc;
}

function _updateForProse(value: string): Uint8Array {
  const doc = proseDoc(value);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function _proseText(doc: Y.Doc): Y.XmlText {
  return proseBlock(doc).get(0) as Y.XmlText;
}

function proseBlock(doc: Y.Doc): Y.XmlElement {
  return doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
}

function appendVisibleText(doc: Y.Doc, value: string) {
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText(value);
  paragraph.push([text]);
  doc.getXmlFragment("prosemirror").push([paragraph]);
  const id = (text as unknown as { _start: { id: { client: number; clock: number } } })._start.id;
  return { clientID: id.client, clock: id.clock, length: value.length };
}

function textRange(doc: Y.Doc) {
  const paragraph = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const text = paragraph.get(0) as Y.XmlText;
  const item = (
    text as unknown as { _start: { id: { client: number; clock: number }; length: number } }
  )._start;
  return { clientID: item.id.client, clock: item.id.clock, length: item.length };
}
