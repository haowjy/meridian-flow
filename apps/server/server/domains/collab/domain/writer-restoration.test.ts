/** Real Yjs histories exercise certified restoration and cold production attribution. */
import {
  captureUndoRestorationClaims,
  RESTORATION_CLAIMS_TYPE,
} from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { type IndexedDraftUpdate, indexDraftUpdates } from "./draft-review-attribution.js";
import { certifyWriterRestorations } from "./writer-restoration.js";

function fixture(trackAi = false) {
  const browser = new Y.Doc({ gc: false });
  browser.clientID = 2001;
  const text = browser.getText("chapter");
  text.insert(0, "The  waits.");
  const baseDoc = new Y.Doc({ gc: false });
  Y.applyUpdate(baseDoc, Y.encodeStateAsUpdate(browser));
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
  const updates: IndexedDraftUpdate[] = [];
  let turn: string | null = "ai-turn";
  let connected = true;
  browser.on("update", (updateData) => {
    if (!connected) return;
    const before = Y.encodeStateVector(server);
    const aliases = certifyWriterRestorations(server, updateData);
    Y.applyUpdate(server, updateData);
    if (
      Buffer.from(before).equals(Buffer.from(Y.encodeStateVector(server))) &&
      Y.decodeUpdate(updateData).ds.clients.size === 0
    )
      return;
    updates.push({
      id: updates.length + 1,
      actorTurnId: turn,
      actorUserId: turn ? null : "writer",
      updateData,
      updateMeta: { restorationAliases: aliases },
    });
  });
  const earlyUndo = trackAi ? new Y.UndoManager(text) : null;
  browser.clientID = 2002;
  text.insert(4, "serpent");
  turn = null;
  browser.clientID = 2003;
  captureUndoRestorationClaims(browser);
  const undo = earlyUndo ?? new Y.UndoManager(text);
  return {
    browser,
    text,
    baseDoc,
    server,
    updates,
    undo,
    disconnect: () => {
      connected = false;
    },
  };
}

function authors(f: ReturnType<typeof fixture>) {
  const index = indexDraftUpdates({ baseDoc: f.baseDoc, updates: f.updates });
  const ranges: Array<{ client: number; clock: number; length: number }> = [];
  for (const structs of f.server.store.clients.values()) {
    for (const item of structs) {
      if (
        item instanceof Y.Item &&
        !item.deleted &&
        item.parent === f.server.getText("chapter") &&
        item.id.client !== 2001
      )
        ranges.push({ ...item.id, length: item.length });
    }
  }
  return index
    .attributeRanges({ insertedRanges: ranges, deletedRanges: [] })
    .insertedAttribution.map((range) => ({
      ...range,
      author: index.byOperationId.get(range.operationId)?.kind,
    }));
}

it("certified Undo and repeated Redo restore the AI author on cold replay", () => {
  const f = fixture();
  f.text.delete(4, 7);
  f.undo.undo();
  expect(f.updates.at(-1)?.updateMeta).toMatchObject({
    restorationAliases: [{ source: { client: 2002 }, target: { client: 2003 } }],
  });
  expect(authors(f)).toMatchObject([{ author: "agent", length: 7 }]);
  f.undo.redo();
  f.undo.undo();
  expect(authors(f)).toMatchObject([{ author: "agent", length: 7 }]);
});

it("partial restoration keeps each source's author", () => {
  const f = fixture();
  f.text.insert(11, " GOLD");
  f.undo.stopCapturing();
  f.text.delete(7, 9);
  f.undo.undo();
  expect(f.text.toString()).toBe("The serpent GOLD waits.");
  expect(
    authors(f)
      .filter((span) => span.author === "agent")
      .reduce((sum, span) => sum + span.length, 0),
  ).toBe(7);
  expect(
    authors(f)
      .filter((span) => span.author === "writer")
      .reduce((sum, span) => sum + span.length, 0),
  ).toBe(5);
});

it("hand retyping with a forged displaced claim remains writer authored", () => {
  const f = fixture();
  f.text.delete(4, 7);
  f.browser.transact(() => {
    f.text.insert(4, "serpent");
    f.browser.getMap(RESTORATION_CLAIMS_TYPE).set("forged", {
      source: { client: 2002, clock: 0, length: 7 },
      target: { client: 2003, clock: 0, length: 7 },
    });
  });
  expect(f.updates.at(-1)?.updateMeta).toEqual({ restorationAliases: [] });
  expect(authors(f)).toMatchObject([{ author: "writer" }]);
});

it("a retried full-state update does not recertify an existing target", () => {
  const f = fixture();
  f.text.delete(4, 7);
  f.undo.undo();
  expect(certifyWriterRestorations(f.server, Y.encodeStateAsUpdate(f.browser))).toEqual([]);
  expect(authors(f)).toMatchObject([{ author: "agent" }]);
});

it("Redo of an AI-authored insertion restores its original author", () => {
  const f = fixture(true);
  f.undo.undo();
  expect(f.text.toString()).toBe("The  waits.");
  f.undo.redo();
  expect(authors(f)).toMatchObject([{ author: "agent", length: 7 }]);
});

it("offline full-state reconciliation preserves the alias and author", () => {
  const f = fixture();
  f.disconnect();
  f.text.delete(7, 4);
  f.undo.undo();
  const updateData = Y.encodeStateAsUpdate(f.browser);
  const restorationAliases = certifyWriterRestorations(f.server, updateData);
  expect(restorationAliases).toHaveLength(1);
  f.updates.push({
    id: 2,
    actorTurnId: null,
    actorUserId: "writer",
    updateData,
    updateMeta: { restorationAliases },
  });
  Y.applyUpdate(f.server, updateData);
  expect(authors(f).every((span) => span.author === "agent")).toBe(true);
  expect(authors(f).reduce((sum, span) => sum + span.length, 0)).toBe(7);
});

it("a claim previously sent without its target cannot certify a future stroke", () => {
  const f = fixture();
  f.text.delete(4, 7);
  f.browser.getMap(RESTORATION_CLAIMS_TYPE).set("stale", {
    source: { client: 2002, clock: 0, length: 7 },
    target: { client: 2003, clock: 1, length: 7 },
  });
  f.text.insert(4, "serpent");
  expect(f.updates.at(-1)?.updateMeta).toEqual({ restorationAliases: [] });
  expect(authors(f)).toMatchObject([{ author: "writer" }]);
});

it("a whole deleted paragraph certifies its restored parent chain and text", () => {
  const browser = new Y.Doc({ gc: false });
  browser.clientID = 2002;
  const root = browser.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  text.insert(0, "serpent");
  root.insert(0, [paragraph]);
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
  browser.clientID = 2003;
  const undo = new Y.UndoManager(root);
  captureUndoRestorationClaims(browser);
  root.delete(0, 1);
  Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
  undo.undo();
  const aliases = certifyWriterRestorations(server, Y.encodeStateAsUpdate(browser));
  expect(aliases).toHaveLength(3);
  expect(aliases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: { client: 2002, clock: 2, length: 7 } }),
    ]),
  );
  undo.destroy();
  browser.destroy();
  server.destroy();
});
