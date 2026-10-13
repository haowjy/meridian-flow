/** Real Yjs histories exercise certified restoration and cold production attribution. */
import {
  captureUndoRestorationClaims,
  RESTORATION_CLAIMS_TYPE,
  type RestorationAlias,
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

function richRestoration(kind: "attribute" | "rich paragraph", content = "abcdef") {
  const browser = new Y.Doc({ gc: false });
  browser.clientID = 3001;
  const root = browser.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  text.insert(0, content);
  root.insert(0, [paragraph]);
  browser.clientID = 3004;
  paragraph.setAttribute("align", "left");
  text.format(2, 2, { bold: true });
  const aiUpdate = Y.encodeStateAsUpdate(browser);
  browser.clientID = 3002;
  const undo = new Y.UndoManager(root);
  const stop = captureUndoRestorationClaims(browser);
  if (kind === "attribute") paragraph.setAttribute("align", "right");
  else root.delete(0, 1);
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
  undo.undo();
  const claims = browser.getMap<RestorationAlias>(RESTORATION_CLAIMS_TYPE);
  return {
    browser,
    server,
    root,
    claims,
    aiUpdate,
    certify: () => certifyWriterRestorations(server, Y.encodeStateAsUpdate(browser)),
    destroy: () => {
      stop();
      undo.destroy();
      browser.destroy();
      server.destroy();
    },
  };
}

it.each([
  "attribute",
  "rich paragraph",
] as const)("certifies only directly proved %s restoration slots and leaves the remainder writer-authored", (kind) => {
  const f = richRestoration(kind);
  const claims = [...f.claims.values()];
  expect(claims).toHaveLength(kind === "attribute" ? 1 : 8);
  expect(f.root.toString()).toBe('<paragraph align="left">ab<bold>cd</bold>ef</paragraph>');
  const restorationAliases = f.certify();
  expect(restorationAliases).toHaveLength(kind === "attribute" ? 0 : 5);
  expect(claims).toEqual(expect.arrayContaining(restorationAliases));
  const baseDoc = new Y.Doc({ gc: false });
  const index = indexDraftUpdates({
    baseDoc,
    updates: [
      { id: 1, actorTurnId: "ai-turn", updateData: f.aiUpdate },
      {
        id: 2,
        actorTurnId: null,
        actorUserId: "writer",
        updateData: Y.encodeStateAsUpdate(f.server),
      },
      {
        id: 3,
        actorTurnId: null,
        actorUserId: "writer",
        updateData: Y.encodeStateAsUpdate(f.browser),
        updateMeta: { restorationAliases },
      },
    ],
  });
  const attribution = index.attributeRanges({
    insertedRanges: claims.map((alias) => alias.target),
    deletedRanges: [],
  });
  expect(attribution.complete).toBe(true);
  expect(attribution.insertedAttribution.reduce((sum, range) => sum + range.length, 0)).toBe(
    kind === "attribute" ? 1 : 11,
  );
  const aiClocks = attribution.insertedAttribution
    .filter((range) => index.byOperationId.get(range.operationId)?.actorTurnId === "ai-turn")
    .reduce((sum, range) => sum + range.length, 0);
  expect(aiClocks).toBe(kind === "attribute" ? 0 : 6);
  baseDoc.destroy();
  f.destroy();
});

it("rejects same-content sibling substitutions in a recreated rich paragraph", () => {
  const f = richRestoration("rich paragraph", "ababab");
  const textAliases = [...f.claims.entries()].filter(([, alias]) => {
    const source = f.browser.store.clients
      .get(alias.source.client)
      ?.find((item) => item.id.clock === alias.source.clock);
    return source instanceof Y.Item && source.content instanceof Y.ContentString;
  });
  expect(textAliases).toHaveLength(3);
  const firstEntry = textAliases[0];
  const lastEntry = textAliases[2];
  if (!firstEntry || !lastEntry) throw new Error("Missing text restoration aliases");
  const [firstKey, first] = firstEntry;
  const [lastKey, last] = lastEntry;
  f.browser.transact(() => {
    f.claims.set(firstKey, { source: last.source, target: first.target });
    f.claims.set(lastKey, { source: first.source, target: last.target });
  });
  const certified = f.certify();
  expect(certified.some((alias) => alias.target.clock === first.target.clock)).toBe(false);
  expect(certified.some((alias) => alias.target.clock === last.target.clock)).toBe(false);
  f.destroy();
});

it("rejects child claims when the restored container has no certified identity", () => {
  const f = richRestoration("rich paragraph");
  for (const [key, alias] of f.claims) {
    if (alias.source.clock === 0) f.claims.delete(key);
  }
  expect(f.certify()).toEqual([]);
  f.destroy();
});

it.each([
  "wrong value",
  "wrong key",
  "oversized range",
] as const)("rejects forged attribute restoration with %s", (forgery) => {
  const f = richRestoration("attribute");
  const entry = [...f.claims.entries()][0];
  if (!entry) throw new Error("Missing attribute restoration alias");
  const [key, alias] = entry;
  if (forgery === "oversized range") {
    f.claims.set(key, {
      source: { ...alias.source, length: 2 },
      target: { ...alias.target, length: 2 },
    });
  } else {
    const paragraph = f.root.get(0) as Y.XmlElement;
    // A fresh copy at a different key, or with different content, cannot borrow
    // the original attribute's author even when its predecessor is tombstoned.
    const attribute = forgery === "wrong key" ? "title" : "align";
    const clock = Y.decodeStateVector(Y.encodeStateVector(f.browser)).get(f.browser.clientID) ?? 0;
    paragraph.setAttribute(attribute, forgery === "wrong value" ? "center" : "left");
    f.claims.set(key, {
      source: alias.source,
      target: { client: f.browser.clientID, clock, length: 1 },
    });
  }
  expect(f.certify()).toEqual([]);
  f.destroy();
});

it("rejects manual equal-value attribute retype with forged claim", () => {
  const browser = new Y.Doc({ gc: false });
  browser.clientID = 4101;
  const paragraph = new Y.XmlElement("paragraph");
  browser.getXmlFragment("prosemirror").insert(0, [paragraph]);
  paragraph.setAttribute("align", "left");
  const source = paragraph._map.get("align");
  if (!source) throw new Error("Missing source attribute");
  browser.clientID = 4102;
  paragraph.setAttribute("align", "right");
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
  const clock = Y.decodeStateVector(Y.encodeStateVector(browser)).get(browser.clientID) ?? 0;
  browser.transact(() => {
    paragraph.setAttribute("align", "left"); // manual edit, no UndoManager
    browser.getMap(RESTORATION_CLAIMS_TYPE).set("forged", {
      source: { ...source.id, length: 1 },
      target: { client: browser.clientID, clock, length: 1 },
    });
  });
  expect(certifyWriterRestorations(server, Y.encodeStateAsUpdate(browser))).toEqual([]);
});

it("omitted sibling claims cannot license same-content substitution", () => {
  const f = richRestoration("rich paragraph", "ababab");
  const entries = [...f.claims.entries()];
  const getSource = (alias: RestorationAlias) =>
    f.browser.store.clients
      .get(alias.source.client)
      ?.find((item) => item.id.clock === alias.source.clock);
  const texts = entries.filter(([, alias]) => {
    const item = getSource(alias);
    return item instanceof Y.Item && item.content instanceof Y.ContentString;
  });
  const firstEntry = texts[0];
  const lastEntry = texts[2];
  if (!firstEntry || !lastEntry) throw new Error("Missing text aliases");
  const [firstKey, first] = firstEntry;
  const [, last] = lastEntry;
  for (const [key, alias] of entries) {
    const source = getSource(alias);
    if (!(source instanceof Y.Item && source.content instanceof Y.ContentType))
      f.claims.delete(key);
  }
  f.claims.set(firstKey, { source: last.source, target: first.target });
  expect(f.certify().some((alias) => alias.target.clock === first.target.clock)).toBe(false);
});

it("recreated writer text cannot borrow equal AI sibling identity", () => {
  const browser = new Y.Doc({ gc: false });
  browser.clientID = 4201;
  const root = browser.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  root.insert(0, [paragraph]);
  text.insert(0, "ab"); // writer authored
  const baseDoc = new Y.Doc({ gc: false });
  Y.applyUpdate(baseDoc, Y.encodeStateAsUpdate(browser));
  const writerSource = { client: 4201, clock: 2, length: 2 };
  browser.clientID = 4202;
  text.insert(2, "ab"); // AI authored
  const aiUpdate = Y.encodeStateAsUpdate(browser);
  const aiSource = { client: 4202, clock: 0, length: 2 };
  browser.clientID = 4203;
  const undo = new Y.UndoManager(root);
  captureUndoRestorationClaims(browser);
  root.delete(0, 1);
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
  undo.undo();
  const claims = browser.getMap<RestorationAlias>(RESTORATION_CLAIMS_TYPE);
  const restoredWriter = [...claims.values()].find(
    (alias) =>
      alias.source.client === writerSource.client && alias.source.clock === writerSource.clock,
  );
  if (!restoredWriter) throw new Error("Missing writer restoration");
  expect(restoredWriter).toBeDefined();
  for (const [key, alias] of claims) {
    if (alias.source.length === 2) claims.delete(key);
  }
  claims.set("forged", { source: aiSource, target: restoredWriter.target });
  const restorationAliases = certifyWriterRestorations(server, Y.encodeStateAsUpdate(browser));
  const index = indexDraftUpdates({
    baseDoc,
    updates: [
      { id: 1, actorTurnId: "ai-turn", updateData: aiUpdate },
      {
        id: 2,
        actorTurnId: null,
        actorUserId: "writer",
        updateData: Y.encodeStateAsUpdate(server),
      },
      {
        id: 3,
        actorTurnId: null,
        actorUserId: "writer",
        updateData: Y.encodeStateAsUpdate(browser),
        updateMeta: { restorationAliases },
      },
    ],
  });
  const attributed = index.attributeRanges({
    insertedRanges: [restoredWriter.target],
    deletedRanges: [],
  });
  expect(
    attributed.insertedAttribution.map(
      (span) => index.byOperationId.get(span.operationId)?.actorTurnId,
    ),
  ).not.toContain("ai-turn");
});

it.each([
  false,
  true,
])("rejects invalid filler coverage in cold attribution (deleted: %s)", (deleted) => {
  const same = (a: { client: number; clock: number }, b: { client: number; clock: number }) =>
    a.client === b.client && a.clock === b.clock;
  const itemAt = (doc: Y.Doc, id: { client: number; clock: number }) =>
    (doc.store.clients.get(id.client) ?? []).find(
      (item) => item.id.clock <= id.clock && id.clock < item.id.clock + item.length,
    );
  const browser = new Y.Doc({ gc: false });
  browser.clientID = 4201;
  const root = browser.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  root.insert(0, [paragraph]);
  text.insert(0, "ab");
  const baseDoc = new Y.Doc({ gc: false });
  Y.applyUpdate(baseDoc, Y.encodeStateAsUpdate(browser));
  const writerSource = { client: 4201, clock: 2, length: 2 };
  browser.clientID = 4202;
  text.insert(2, "ab");
  const aiUpdate = Y.encodeStateAsUpdate(browser);
  const aiSource = { client: 4202, clock: 0, length: 2 };
  browser.clientID = 4203;
  const undo = new Y.UndoManager(root);
  captureUndoRestorationClaims(browser);
  root.delete(0, 1);
  const server = new Y.Doc({ gc: false });
  Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
  undo.undo();
  const claims = browser.getMap<RestorationAlias>(RESTORATION_CLAIMS_TYPE);
  const writerAlias = [...claims.entries()].find(([, a]) => same(a.source, writerSource));
  const aiAlias = [...claims.entries()].find(([, a]) => same(a.source, aiSource));
  if (!writerAlias || !aiAlias) throw new Error("missing text aliases");
  const firstTarget = writerAlias[1].target;
  const secondTarget = aiAlias[1].target;
  // The UndoManager recreates the paragraph/text objects; reacquire the live text container.
  const restoredParagraph = root.get(0);
  if (!(restoredParagraph instanceof Y.XmlElement)) throw new Error("missing restored paragraph");
  const restoredText = restoredParagraph.get(0);
  if (!(restoredText instanceof Y.XmlText)) throw new Error("missing restored text");
  // Delete restored second AI `ab`.
  const secondTargetItem = itemAt(browser, secondTarget);
  if (!(secondTargetItem instanceof Y.Item)) throw new Error("missing second target item");
  if (secondTargetItem.parent !== restoredText)
    throw new Error("AI target is not restored text child");
  restoredText.delete(2, 2);
  // Insert zz immediately before restored first writer ab, then delete zz.
  restoredText.insert(0, "zz");
  if (deleted) restoredText.delete(0, 2);
  const zzTargetItem = [...browser.store.clients.values()]
    .flat()
    .find(
      (item) =>
        item instanceof Y.Item &&
        item.parent === restoredText &&
        item.content instanceof Y.ContentString &&
        item.content.str === "zz",
    );
  if (!(zzTargetItem instanceof Y.Item)) throw new Error("missing zz tombstone");
  const liveFirstItem = itemAt(browser, firstTarget);
  if (!(liveFirstItem instanceof Y.Item) || liveFirstItem.deleted)
    throw new Error("first writer target is not live");
  // Keep parent alias. Replace text claims with the requested forged mapping.
  claims.set(writerAlias[0], { source: writerSource, target: { ...zzTargetItem.id, length: 2 } });
  claims.set(aiAlias[0], { source: aiSource, target: { ...liveFirstItem.id, length: 2 } });
  const update = Y.encodeStateAsUpdate(browser);
  const certified = certifyWriterRestorations(server, update);
  const forgedAiAccepted = certified.some(
    (alias) => same(alias.source, aiSource) && same(alias.target, liveFirstItem.id),
  );

  const index = indexDraftUpdates({
    baseDoc,
    updates: [
      { id: 1, actorTurnId: "ai-turn", updateData: aiUpdate },
      {
        id: 2,
        actorTurnId: null,
        actorUserId: "writer",
        updateData: Y.encodeStateAsUpdate(server),
      },
      {
        id: 3,
        actorTurnId: null,
        actorUserId: "writer",
        updateData: update,
        updateMeta: { restorationAliases: certified },
      },
    ],
  });
  const attributed = index.attributeRanges({
    insertedRanges: [{ ...liveFirstItem.id, length: 2 }],
    deletedRanges: [],
  });
  const forgedAiColdAttribution = attributed.insertedAttribution.some(
    (span) => index.byOperationId.get(span.operationId)?.actorTurnId === "ai-turn",
  );
  expect(attributed.complete).toBe(true);
  expect(forgedAiColdAttribution).toBe(false);
  expect(forgedAiAccepted).toBe(false);
  undo.destroy();
  browser.destroy();
  server.destroy();
  baseDoc.destroy();
});
