// @vitest-environment jsdom
/** Contract coverage for bind-time schema repair observation and evidence. */

import { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "./config";
import { DocumentSession } from "./document-session";
import { createLocalPresence } from "./local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";
import { createSchemaRepairWitness, type SchemaRepairEvent } from "./schema-repair-witness";

const editors: Editor[] = [];
const witnesses: ReturnType<typeof createSchemaRepairWitness>[] = [];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  for (const editor of editors.splice(0)) {
    if (!editor.isDestroyed) editor.destroy();
  }
  for (const witness of witnesses.splice(0)) witness.destroy();
  vi.unstubAllGlobals();
});

function appendElement(
  doc: Y.Doc,
  nodeName: string,
  text: string,
  origin: unknown = "seed",
): Y.XmlElement {
  const element = new Y.XmlElement(nodeName);
  const yText = new Y.XmlText();
  doc.transact(() => {
    doc
      .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
      .insert(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).length, [element]);
    element.insert(0, [yText]);
    yText.insert(0, text);
  }, origin);
  return element;
}

function foreignElementUpdate(doc: Y.Doc, nodeName: string, text: string): Uint8Array {
  const foreign = new Y.Doc({ gc: false });
  Y.applyUpdate(foreign, Y.encodeStateAsUpdate(doc), "copy-valid-state");
  const baseline = Y.encodeStateVector(doc);
  appendElement(foreign, nodeName, text, "foreign-client-insert");
  return Y.encodeStateAsUpdate(foreign, baseline);
}

async function finishFlush(): Promise<void> {
  await Promise.resolve();
}

function constructEditor(
  doc: Y.Doc,
  events: SchemaRepairEvent[],
  evidenceDegraded = false,
): Editor {
  const witness = createSchemaRepairWitness({
    document: doc,
    onRepair: (event) => events.push(event),
    evidenceDegraded,
    now: () => "2026-07-28T12:00:00.000Z",
  });
  witnesses.push(witness);
  try {
    const editor = new Editor({
      element: document.createElement("div"),
      ...createEditorConfig({
        document: doc,
        presence: createLocalPresence(new Awareness(doc)),
        showCollaborationDecorations: false,
      }),
    });
    editors.push(editor);
    witness.enterLive(editor);
    return editor;
  } catch (error) {
    witness.destroy();
    throw error;
  }
}

function liveWitnessWithoutBinding(doc: Y.Doc, events: SchemaRepairEvent[]) {
  const transactionHandlers = new Set<(payload: { transaction: Transaction }) => void>();
  const editor = {
    on: (_event: string, handler: (payload: { transaction: Transaction }) => void) => {
      transactionHandlers.add(handler);
    },
    off: (_event: string, handler: (payload: { transaction: Transaction }) => void) => {
      transactionHandlers.delete(handler);
    },
  } as unknown as Editor;
  const witness = createSchemaRepairWitness({
    document: doc,
    onRepair: (event) => events.push(event),
    now: () => "2026-07-28T12:00:00.000Z",
  });
  witnesses.push(witness);
  witness.enterLive(editor);
  return {
    witness,
    dispatchUserTransaction() {
      const transaction = {
        getMeta: () => undefined,
        steps: [],
        docs: [],
      } as unknown as Transaction;
      for (const handler of transactionHandlers) handler({ transaction });
    },
  };
}

describe("schema repair witness", () => {
  it("reports the exact prose and node identity removed during editor construction", () => {
    const doc = new Y.Doc({ gc: false });
    appendElement(doc, "paragraph", "kept prose");
    appendElement(doc, "sidebar", "future prose");
    const events: SchemaRepairEvent[] = [];

    const editor = constructEditor(doc, events);

    expect(editor.getText()).toContain("kept prose");
    expect(events).toEqual([
      {
        phase: "open",
        detectedAt: "2026-07-28T12:00:00.000Z",
        deletedNodeTypes: ["sidebar"],
        deletedClockCount: "future prose".length + 2,
        removedText: "future prose",
      },
    ]);
  });

  it("reports one live repair for a post-bind foreign invalid insert and preserves convergence", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc), "initial-peer-state");
    const events: SchemaRepairEvent[] = [];
    const editor = constructEditor(doc, events);
    const propagatedUpdates: Uint8Array[] = [];
    doc.on("update", (update) => propagatedUpdates.push(update));

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "sidebar", "remote future prose"),
      "remote-provider-origin",
    );
    await finishFlush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "live",
      deletedNodeTypes: ["sidebar"],
      removedText: "remote future prose",
    });
    expect(events[0]?.evidenceDegraded).toBeUndefined();
    expect(editor.getText()).toBe("valid prose");

    for (const update of propagatedUpdates) {
      Y.applyUpdate(peer, update, "peer-provider-origin");
    }
    expect(peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toString()).toBe(
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toString(),
    );
    expect([...Y.decodeStateVector(Y.encodeStateVector(peer))]).toEqual([
      ...Y.decodeStateVector(Y.encodeStateVector(doc)),
    ]);
  });

  it("keeps clean local and collaborative editing at zero verdicts", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "writer prose");
    const events: SchemaRepairEvent[] = [];
    const editor = constructEditor(doc, events);

    expect(editor.commands.insertContentAt(7, " new")).toBe(true);
    expect(editor.commands.deleteRange({ from: 1, to: 3 })).toBe(true);
    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "paragraph", "remote valid prose"),
      "remote-provider-origin",
    );
    // A completed remote Yjs batch must not leak its binding meta into the
    // causally separate writer command that follows in the same JavaScript turn.
    expect(editor.commands.deleteRange({ from: 1, to: 3 })).toBe(true);
    await finishFlush();

    expect(events).toEqual([]);
  });

  it.each([
    ["valid remote content", "paragraph", "remote valid prose", "remote", 3, []],
    ["valid remote content and marked prose", "paragraph", "remote valid prose", "bold", 7, []],
    ["a repair before binding cleanup", "sidebar", "invalid prose", "before", 3, ["invalid prose"]],
    [
      "a repair before the writer command",
      "sidebar",
      "invalid prose",
      "after",
      3,
      ["invalid prose"],
    ],
  ] as const)("attributes only the repair when a writer deletion shares a batch with %s", async (_name, remoteNode, remoteText, writerOrder, deleteTo, expectedRemovedText) => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "writer prose");
    const events: SchemaRepairEvent[] = [];
    let editor: Editor;
    let deleted = false;
    const deleteWriterText = () => {
      if (deleted) return;
      deleted = true;
      expect(editor.commands.deleteRange({ from: 1, to: deleteTo })).toBe(true);
    };
    const deleteBeforeBindingCleanup = () => {
      if (writerOrder === "before") deleteWriterText();
    };
    if (writerOrder === "before") {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).observeDeep(deleteBeforeBindingCleanup);
    }
    editor = constructEditor(doc, events);
    if (writerOrder === "bold") {
      expect(editor.chain().setTextSelection({ from: 1, to: deleteTo }).setBold().run()).toBe(true);
    }
    const deleteDuringCleanup = (transaction: Y.Transaction) => {
      if (
        ((writerOrder === "remote" || writerOrder === "bold") &&
          transaction.origin === "remote-provider-origin") ||
        (writerOrder === "after" &&
          transaction.origin === ySyncPluginKey &&
          transaction.deleteSet.clients.size > 0)
      ) {
        deleteWriterText();
      }
    };
    doc.on("afterTransaction", deleteDuringCleanup);

    Y.applyUpdate(doc, foreignElementUpdate(doc, remoteNode, remoteText), "remote-provider-origin");
    await finishFlush();
    doc.off("afterTransaction", deleteDuringCleanup);
    if (writerOrder === "before") {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).unobserveDeep(deleteBeforeBindingCleanup);
    }

    expect(events.map((event) => event.removedText)).toEqual(expectedRemovedText);
  });

  it("does not carry remote fallback eligibility into a new Yjs batch", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    appendElement(doc, "sidebar", "first fallback");
    const separateText = doc.getText("separate");
    separateText.insert(0, "second separate");
    const events: SchemaRepairEvent[] = [];
    liveWitnessWithoutBinding(doc, events);
    const root = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    let repaired = false;
    doc.on("afterTransaction", (transaction) => {
      if (transaction.origin !== "remote-provider-origin" || repaired) return;
      repaired = true;
      doc.transact(() => root.delete(1, 1), ySyncPluginKey);
    });

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "paragraph", "remote valid prose"),
      "remote-provider-origin",
    );
    doc.transact(() => separateText.delete(0, separateText.length), ySyncPluginKey);
    await finishFlush();

    expect(events.map((event) => event.removedText)).toEqual(["first fallback"]);
  });
});

describe("shared session repair observation", () => {
  const sessions: DocumentSession[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.destroy();
  });

  function sessionWith(nodeName = "paragraph", text = "fwf") {
    const session = new DocumentSession({
      roomKey: "5a4aad0b-8f47-4e3e-88b4-aad3ce2ac507",
      persistence: { kind: "none" },
    });
    sessions.push(session);
    appendElement(session.document, nodeName, text);
    return session;
  }

  function bind(session: DocumentSession) {
    const { editor, release } = session.bindEditor(
      () =>
        new Editor({
          element: document.createElement("div"),
          ...createEditorConfig({
            document: session.document,
            presence: session.presence,
            showCollaborationDecorations: false,
          }),
        }),
    );
    editors.push(editor);
    editor.on("destroy", release);
    return editor;
  }

  it("attributes fwf deletions from either bound view to the writer", async () => {
    const session = sessionWith();
    const first = bind(session);
    const second = bind(session);
    for (const editor of [first, second]) {
      editor.commands.setContent("<p>fwf</p>");
      for (let index = 0; index < 3; index += 1) {
        editor.commands.deleteRange({ from: 1, to: 2 });
        await finishFlush();
      }
    }
    expect(session.getSnapshot().schemaRepairs).toEqual([]);
    expect(first.getText()).toBe("");
    expect(second.getText()).toBe("");
  });

  it("attributes supported paragraph removal from either view to the writer", async () => {
    const session = sessionWith();
    const views = [bind(session), bind(session)];
    for (const editor of views) {
      editor.commands.setContent("<p>first paragraph</p><p>second paragraph</p>");
      editor.commands.selectAll();
      editor.commands.deleteSelection();
      await finishFlush();
    }
    expect(session.getSnapshot().schemaRepairs).toEqual([]);
    expect(views.map((editor) => editor.getText())).toEqual(["", ""]);
  });

  it("opens valid content and observes a single writer without repairs", async () => {
    const session = sessionWith();
    const editor = bind(session);
    expect(session.getSnapshot().schemaRepairs).toEqual([]);
    editor.commands.deleteRange({ from: 1, to: 4 });
    await finishFlush();
    expect(session.getSnapshot().schemaRepairs).toEqual([]);
  });

  it("reports a genuine open repair once, even when a later view binds", () => {
    const session = sessionWith("sidebar", "recover this prose");
    bind(session);
    bind(session);
    expect(session.getSnapshot().schemaRepairs).toMatchObject([
      { phase: "open", deletedNodeTypes: ["sidebar"], removedText: "recover this prose" },
    ]);
    expect(session.getSnapshot().schemaRepairs).toHaveLength(1);
  });

  it.each([0, 1])("keeps observation live after view %s unmounts", async (unmounted) => {
    const session = sessionWith();
    const first = bind(session);
    first.commands.insertContent("before second mount");
    await finishFlush();
    const views = [first, bind(session)];
    views[unmounted]?.destroy();
    const remaining = views[1 - unmounted];
    remaining?.commands.selectAll();
    remaining?.commands.deleteSelection();
    await finishFlush();
    expect(session.getSnapshot().schemaRepairs).toEqual([]);
    Y.applyUpdate(session.document, foreignElementUpdate(session.document, "sidebar", "survives"));
    await finishFlush();
    expect(session.getSnapshot().schemaRepairs).toMatchObject([
      { phase: "live", deletedNodeTypes: ["sidebar"], removedText: "survives" },
    ]);
    expect(session.getSnapshot().schemaRepairs).toHaveLength(1);
  });

  it("reports one unsupported live node across two views", async () => {
    const session = sessionWith();
    bind(session);
    bind(session);
    Y.applyUpdate(session.document, foreignElementUpdate(session.document, "sidebar", "f,w,f"));
    await finishFlush();
    expect(session.getSnapshot().schemaRepairs).toMatchObject([
      { phase: "live", deletedNodeTypes: ["sidebar"], removedText: "f,w,f" },
    ]);
    expect(session.getSnapshot().schemaRepairs).toHaveLength(1);
  });
});
