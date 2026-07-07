/** Unit coverage for Yjs journal dependency edge extraction. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  decodeUpdateForDependencies,
  deleteRanges,
  hasDependentLaterRows,
  rangesOverlap,
  suppliedRanges,
} from "./journal-dependencies.js";

function row(updateData: Uint8Array) {
  return { updateData };
}

describe("journal dependency predicates", () => {
  it("treats rightOrigin-only inserts before selected content as dependency edges", () => {
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText("content");

    const beforeSelected = Y.encodeStateVector(doc);
    text.insert(0, "agent");
    const selectedUpdate = Y.encodeStateAsUpdate(doc, beforeSelected);
    const selectedRanges = suppliedRanges(decodeUpdateForDependencies(selectedUpdate));

    const beforeWriter = Y.encodeStateVector(doc);
    text.insert(0, "W");
    const writerUpdate = Y.encodeStateAsUpdate(doc, beforeWriter);
    const writerDecoded = decodeUpdateForDependencies(writerUpdate);
    const [writerStruct] = writerDecoded.structs ?? [];
    const rightOrigin = writerStruct?.rightOrigin;

    expect(rightOrigin).toBeDefined();
    expect(writerStruct?.origin).toBeNull();
    expect(deleteRanges(writerDecoded)).toHaveLength(0);
    expect(
      rightOrigin &&
        selectedRanges.some((range) => rangesOverlap(range, { ...rightOrigin, length: 1 })),
    ).toBe(true);
    expect(hasDependentLaterRows([row(selectedUpdate)], [row(writerUpdate)])).toBe(true);
  });

  it("treats parent-id references as dependency edges", () => {
    const doc = new Y.Doc({ gc: false });
    const fragment = doc.getXmlFragment("prosemirror");
    const beforeElement = Y.encodeStateVector(doc);
    const paragraph = new Y.XmlElement("paragraph");
    fragment.insert(0, [paragraph]);
    const elementUpdate = Y.encodeStateAsUpdate(doc, beforeElement);

    const beforeText = Y.encodeStateVector(doc);
    paragraph.insert(0, [new Y.XmlText("hello")]);
    const childUpdate = Y.encodeStateAsUpdate(doc, beforeText);

    expect(hasDependentLaterRows([row(elementUpdate)], [row(childUpdate)])).toBe(true);
  });

  it("keeps delete-only rows undoable when later rows touch independent content", () => {
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText("content");
    text.insert(0, "abcdef");

    const beforeDelete = Y.encodeStateVector(doc);
    text.delete(2, 2);
    const deleteOnlyUpdate = Y.encodeStateAsUpdate(doc, beforeDelete);

    const beforeAppend = Y.encodeStateVector(doc);
    text.insert(text.length, "Z");
    const appendUpdate = Y.encodeStateAsUpdate(doc, beforeAppend);

    expect(hasDependentLaterRows([row(deleteOnlyUpdate)], [row(appendUpdate)])).toBe(false);
  });

  it("degrades delete-only undo when a later row references the restored range", () => {
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText("content");
    text.insert(0, "abcdef");

    const beforeDelete = Y.encodeStateVector(doc);
    text.delete(2, 2);
    const deleteOnlyUpdate = Y.encodeStateAsUpdate(doc, beforeDelete);

    const dependent = new Y.Doc({ gc: false });
    Y.applyUpdate(dependent, Y.encodeStateAsUpdate(doc));
    const dependentText = dependent.getText("content");
    const beforeDependent = Y.encodeStateVector(dependent);
    // Re-applying the deleted content as an undo peer makes a later update depend
    // on the same struct range the selected delete-only row would restore.
    dependentText.insert(2, "cd");
    const dependentUpdate = Y.encodeStateAsUpdate(dependent, beforeDependent);

    expect(hasDependentLaterRows([row(deleteOnlyUpdate)], [row(dependentUpdate)])).toBe(true);
  });

  it("pins cumulative delete-set false positives as conservative degradation", () => {
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText("content");
    text.insert(0, "abcdef");

    const beforeFirstDelete = Y.encodeStateVector(doc);
    text.delete(0, 2);
    const afterFirstDelete = Y.encodeStateVector(doc);
    text.delete(0, 2);
    const secondDeleteUpdate = Y.encodeStateAsUpdate(doc, afterFirstDelete);

    const later = new Y.Doc({ gc: false });
    Y.applyUpdate(later, Y.encodeStateAsUpdate(doc));
    const laterText = later.getText("content");
    const beforeLater = Y.encodeStateVector(later);
    laterText.insert(0, "ab");
    const laterReferencesFirstDeleteRange = Y.encodeStateAsUpdate(later, beforeLater);

    expect(Y.decodeUpdate(secondDeleteUpdate).ds.clients.size).toBeGreaterThan(0);
    expect(
      hasDependentLaterRows([row(secondDeleteUpdate)], [row(laterReferencesFirstDeleteRange)]),
    ).toBe(true);
    expect(beforeFirstDelete).toBeInstanceOf(Uint8Array);
  });
});
