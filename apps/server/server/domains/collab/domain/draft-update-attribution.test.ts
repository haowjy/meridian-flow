/** Unit coverage for effective draft-update attribution over Yjs row ranges. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { indexDraftUpdates } from "./draft-update-attribution.js";

function createTextDoc(text: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const yText = doc.getText("body");
  yText.insert(0, text);
  return { doc, text: yText };
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  mutate();
  return Y.encodeStateAsUpdate(doc, before);
}

describe("draft update attribution index", () => {
  it("keeps plain sequential cumulative delete sets attributed to their own rows", () => {
    const { doc: live } = createTextDoc("Alpha target Beta target Gamma target");
    const draft = cloneDoc(live);
    const text = draft.getText("body");
    const first = captureUpdate(draft, () => text.delete(6, 6));
    const second = captureUpdate(draft, () => text.delete(12, 6));
    const third = captureUpdate(draft, () => text.delete(18, 6));

    const index = indexDraftUpdates({
      baseDoc: live,
      updates: [
        { id: 1, actorTurnId: "turn-1", updateData: first },
        { id: 2, actorTurnId: "turn-2", updateData: second },
        { id: 3, actorTurnId: "turn-3", updateData: third },
      ],
    });

    expect(
      index.operationIdsForRanges({
        insertedRanges: [],
        deletedRanges: [{ client: 1, clock: 6, length: 6 }],
      }),
    ).toEqual(["1"]);
    expect(
      index.operationIdsForRanges({
        insertedRanges: [],
        deletedRanges: [{ client: 1, clock: 18, length: 6 }],
      }),
    ).toEqual(["2"]);
    expect(
      index.operationIdsForRanges({
        insertedRanges: [],
        deletedRanges: [{ client: 1, clock: 30, length: 6 }],
      }),
    ).toEqual(["3"]);
  });

  it("attributes delete undo re-delete to the last effective delete row", () => {
    const { doc: live } = createTextDoc("Alpha sword tail");
    const draft = cloneDoc(live);
    const text = draft.getText("body");
    const undoManager = new Y.UndoManager(text);
    const firstDelete = captureUpdate(draft, () => text.delete(6, 5));
    const undo = captureUpdate(draft, () => undoManager.undo());
    const secondDelete = captureUpdate(draft, () => text.delete(6, 5));

    const index = indexDraftUpdates({
      baseDoc: live,
      updates: [
        { id: 11, actorTurnId: "turn-first", updateData: firstDelete },
        { id: 12, actorTurnId: "turn-undo", updateData: undo },
        { id: 13, actorTurnId: "turn-second", updateData: secondDelete },
      ],
    });

    expect(
      index.operationIdsForRanges({
        insertedRanges: [],
        deletedRanges: [{ client: 1, clock: 6, length: 5 }],
      }),
    ).toEqual(["13"]);
  });

  it("attributes undo-restored inserted ranges to the row that introduced them", () => {
    const { doc: live } = createTextDoc("foo ");
    const draft = cloneDoc(live);
    const text = draft.getText("body");
    const agentInsert = captureUpdate(draft, () => text.insert(4, "AI"));
    const undoManager = new Y.UndoManager(text, { captureTimeout: 0 });
    const inverse = captureUpdate(draft, () => text.delete(4, 2));
    const undo = captureUpdate(draft, () => undoManager.undo());
    const [restoredRange] = insertedRanges(undo);

    const index = indexDraftUpdates({
      baseDoc: live,
      updates: [
        { id: 21, actorTurnId: "turn-agent", updateData: agentInsert },
        { id: 22, actorTurnId: null, actorUserId: "user-a", updateData: inverse },
        { id: 23, actorTurnId: null, actorUserId: "user-a", updateData: undo },
      ],
    });

    expect(index.byOperationId.get("23")).toBeUndefined();
    expect(
      index.operationIdsForRanges({ insertedRanges: [restoredRange], deletedRanges: [] }),
    ).toEqual(["21"]);
  });

  it("keeps fresh writer text in a restorative row attributed to the writer", () => {
    const { doc: live } = createTextDoc("foo ");
    const draft = cloneDoc(live);
    const text = draft.getText("body");
    const agentInsert = captureUpdate(draft, () => text.insert(4, "AI"));
    const undoManager = new Y.UndoManager(text, { captureTimeout: 0 });
    const inverse = captureUpdate(draft, () => text.delete(4, 2));
    const undoAndFreshText = captureUpdate(draft, () => {
      undoManager.undo();
      text.insert(text.length, " fresh");
    });
    const [restoredRange, freshRange] = insertedRanges(undoAndFreshText);

    const index = indexDraftUpdates({
      baseDoc: live,
      updates: [
        { id: 31, actorTurnId: "turn-agent", updateData: agentInsert },
        { id: 32, actorTurnId: null, actorUserId: "user-a", updateData: inverse },
        { id: 33, actorTurnId: null, actorUserId: "user-a", updateData: undoAndFreshText },
      ],
    });

    expect(index.byOperationId.get("33")).toMatchObject({ kind: "writer", actorUserId: "user-a" });
    expect(
      index.operationIdsForRanges({ insertedRanges: [restoredRange], deletedRanges: [] }),
    ).toEqual(["31"]);
    expect(
      index.operationIdsForRanges({ insertedRanges: [freshRange], deletedRanges: [] }),
    ).toEqual(["33"]);
  });
  it("aliases a discard undo restore row back to the original agent operation", () => {
    const { doc: live } = createTextDoc("blue");
    const draft = cloneDoc(live);
    const text = draft.getText("body");
    const agentUndoManager = new Y.UndoManager(text, { captureTimeout: 0 });
    const agentRewrite = captureUpdate(draft, () => {
      text.delete(0, 4);
      text.insert(0, "emerald");
    });
    agentUndoManager.stopCapturing();
    const discardUndoManager = new Y.UndoManager(text, { captureTimeout: 0 });
    const discardInverse = captureUpdate(draft, () => agentUndoManager.undo());
    discardUndoManager.stopCapturing();
    const undoDiscard = captureUpdate(draft, () => discardUndoManager.undo());

    const index = indexDraftUpdates({
      baseDoc: live,
      updates: [
        { id: 41, actorTurnId: "turn-agent", updateData: agentRewrite },
        { id: 42, actorTurnId: null, actorUserId: "user-a", updateData: discardInverse },
        { id: 43, actorTurnId: null, actorUserId: "user-a", updateData: undoDiscard },
      ],
    });

    expect(index.byOperationId.get("43")).toBeUndefined();
    expect(
      index.operationIdsForRanges({
        insertedRanges: [],
        deletedRanges: [{ client: 1, clock: 0, length: 4 }],
      }),
    ).toEqual(["41"]);
  });
});

function insertedRanges(update: Uint8Array) {
  return Y.decodeUpdate(update).structs.map((struct) => {
    const typed = struct as { id: { client: number; clock: number }; length: number };
    return { client: typed.id.client, clock: typed.id.clock, length: typed.length };
  });
}
