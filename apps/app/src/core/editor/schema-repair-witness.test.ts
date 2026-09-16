// @vitest-environment jsdom
/** Contract coverage for bind-time schema repair observation and evidence. */

import { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "./config";
import { createLocalPresence } from "./local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";
import {
  createSchemaRepairWitness,
  extractSchemaRepairEvidence,
  type SchemaRepairEvent,
} from "./schema-repair-witness";

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

  it("resolves a deleted repeated sibling by Y item identity rather than position", () => {
    const doc = new Y.Doc({ gc: false });
    appendElement(doc, "paragraph", "first repeated sibling");
    appendElement(doc, "paragraph", "second repeated sibling");
    const before = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array | null = null;
    doc.on("update", (update, origin) => {
      if (origin === "delete-second") deletion = update;
    });

    doc.transact(() => {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(1, 1);
    }, "delete-second");

    expect(deletion).not.toBeNull();
    expect(extractSchemaRepairEvidence(before, deletion as unknown as Uint8Array)).toEqual({
      deletedNodeTypes: ["paragraph"],
      deletedClockCount: "second repeated sibling".length + 2,
      removedText: "second repeated sibling",
    });
  });

  it("captures every disjoint clock range deleted from one text item", () => {
    const doc = new Y.Doc({ gc: false });
    const paragraph = appendElement(doc, "paragraph", "abcdef");
    const yText = paragraph.get(0) as Y.XmlText;
    const before = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array | null = null;
    doc.on("update", (update, origin) => {
      if (origin === "delete-disjoint") deletion = update;
    });

    doc.transact(() => {
      yText.delete(1, 1);
      yText.delete(2, 1);
    }, "delete-disjoint");

    expect(extractSchemaRepairEvidence(before, deletion as unknown as Uint8Array)).toEqual({
      deletedNodeTypes: [],
      deletedClockCount: 2,
      removedText: "bd",
    });
  });

  it("preserves prose boundaries between deleted block siblings", () => {
    const doc = new Y.Doc({ gc: false });
    appendElement(doc, "paragraph", "first passage");
    appendElement(doc, "paragraph", "second passage");
    const before = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array | null = null;
    doc.on("update", (update, origin) => {
      if (origin === "delete-blocks") deletion = update;
    });

    doc.transact(() => {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(0, 2);
    }, "delete-blocks");

    expect(extractSchemaRepairEvidence(before, deletion as unknown as Uint8Array)).toEqual({
      deletedNodeTypes: ["paragraph"],
      deletedClockCount: "first passage".length + "second passage".length + 4,
      removedText: "first passage\nsecond passage",
    });
  });

  it("preserves an empty structural separator between removed text items", () => {
    const doc = new Y.Doc({ gc: false });
    const block = new Y.XmlElement("future_block");
    const beforeText = new Y.XmlText();
    const hardBreak = new Y.XmlElement("hard_break");
    const afterText = new Y.XmlText();
    doc.transact(() => {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [block]);
      block.insert(0, [beforeText, hardBreak, afterText]);
      beforeText.insert(0, "before");
      afterText.insert(0, "after");
    }, "seed-structural-separator");
    const before = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array | null = null;
    doc.on("update", (update, origin) => {
      if (origin === "delete-structural-separator") deletion = update;
    });

    doc.transact(() => {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(0, 1);
    }, "delete-structural-separator");

    expect(extractSchemaRepairEvidence(before, deletion as unknown as Uint8Array)).toMatchObject({
      deletedNodeTypes: ["future_block", "hard_break"],
      removedText: "before\nafter",
    });
  });

  it("marks a verdict when the bind horizon evidence was degraded", () => {
    const doc = new Y.Doc({ gc: false });
    appendElement(doc, "sidebar", "late evidence");
    const events: SchemaRepairEvent[] = [];

    constructEditor(doc, events, true);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "open",
      removedText: "late evidence",
      evidenceDegraded: true,
    });
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

  it("reports a live repair when the witness goes live inside editor construction", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "kept prose");
    appendElement(doc, "sidebar", "future prose");
    const events: SchemaRepairEvent[] = [];
    const witness = createSchemaRepairWitness({
      document: doc,
      onRepair: (event) => events.push(event),
      now: () => "2026-07-28T12:00:00.000Z",
    });
    witnesses.push(witness);
    const editor = new Editor({
      element: document.createElement("div"),
      ...createEditorConfig({
        document: doc,
        presence: createLocalPresence(new Awareness(doc)),
        showCollaborationDecorations: false,
      }),
      // The spike's construction sequence: the witness is already live when
      // Collaboration binds, so the bind-time removal has to arrive through
      // the live correlator rather than the open-phase path.
      onBeforeCreate: ({ editor: live }) => witness.enterLive(live),
    });
    editors.push(editor);
    await finishFlush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "live",
      deletedNodeTypes: ["sidebar"],
      removedText: "future prose",
    });
    expect(editor.getText()).toContain("kept prose");
  });

  it("reports a remote-interleaved y-sync deletion when no user transaction occurs", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const events: SchemaRepairEvent[] = [];
    const editor = constructEditor(doc, events);
    editor.destroy();

    let repaired = false;
    const repairAfterRemote = (transaction: Y.Transaction) => {
      if (transaction.origin !== "remote-provider-origin" || repaired) return;
      repaired = true;
      doc.transact(() => {
        doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(1, 1);
      }, ySyncPluginKey);
    };
    doc.on("afterTransaction", repairAfterRemote);

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "sidebar", "interleaved future prose"),
      "remote-provider-origin",
    );
    await finishFlush();
    doc.off("afterTransaction", repairAfterRemote);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "live",
      deletedNodeTypes: ["sidebar"],
      removedText: "interleaved future prose",
    });
  });

  it.each([
    "before",
    "after",
  ] as const)("retains a live repair when an unrelated user transaction occurs %s it in the same batch", async (userTransactionOrder) => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    appendElement(doc, "sidebar", "interleaved future prose");
    const events: SchemaRepairEvent[] = [];
    const { dispatchUserTransaction } = liveWitnessWithoutBinding(doc, events);
    const root = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    let repaired = false;
    const repairAfterRemote = (transaction: Y.Transaction) => {
      if (transaction.origin !== "remote-provider-origin" || repaired) return;
      repaired = true;
      if (userTransactionOrder === "before") dispatchUserTransaction();
      doc.transact(() => root.delete(1, 1), ySyncPluginKey);
      if (userTransactionOrder === "after") dispatchUserTransaction();
    };
    doc.on("afterTransaction", repairAfterRemote);

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "paragraph", "remote valid prose"),
      "remote-provider-origin",
    );
    await finishFlush();
    doc.off("afterTransaction", repairAfterRemote);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "live",
      deletedNodeTypes: ["sidebar"],
      removedText: "interleaved future prose",
    });
  });

  it("reports magnitude with degraded evidence when deleted structs are not resolvable", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const unboundText = doc.getText("unbound");
    unboundText.insert(0, "unrecoverable");
    const events: SchemaRepairEvent[] = [];
    const editor = constructEditor(doc, events);

    doc.transact(() => unboundText.delete(0, unboundText.length), ySyncPluginKey);
    editor.view.dispatch(
      editor.state.tr.setMeta(ySyncPluginKey, {
        isChangeOrigin: true,
      }),
    );
    await finishFlush();

    expect(events).toEqual([
      expect.objectContaining({
        phase: "live",
        deletedNodeTypes: [],
        deletedClockCount: "unrecoverable".length,
        evidenceDegraded: true,
      }),
    ]);
    expect(events[0]?.removedText).toBeUndefined();
  });

  it("accumulates repeat live repairs", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const events: SchemaRepairEvent[] = [];
    constructEditor(doc, events);

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "sidebar", "first future prose"),
      "remote-provider-origin",
    );
    await finishFlush();
    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "sidebar", "second future prose"),
      "remote-provider-origin",
    );
    await finishFlush();

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.phase)).toEqual(["live", "live"]);
    expect(events.map((event) => event.removedText)).toEqual([
      "first future prose",
      "second future prose",
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

  it("reports an eligible pending repair only once across repeated destroy", () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    appendElement(doc, "sidebar", "destroy candidate");
    const events: SchemaRepairEvent[] = [];
    const { witness } = liveWitnessWithoutBinding(doc, events);
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
    witness.destroy();
    witness.destroy();

    expect(events).toHaveLength(1);
    expect(events[0]?.removedText).toBe("destroy candidate");
  });
});

/**
 * The one upstream bit the witness reads off the y-prosemirror fork.
 *
 * `bindingDispatched` asks whether a ProseMirror transaction carries y-sync
 * meta with `binding` or `isChangeOrigin` on it, and that question is the whole
 * adapter contract: listener order, batching, and the rest of the meta keys are
 * the fork's business and may change without changing a verdict. This asserts
 * the bit, so an upstream bump that breaks the correlator names itself here.
 */
describe("the y-sync meta the witness correlates on", () => {
  function carriesBindingMeta(transaction: Transaction): boolean {
    const meta = transaction.getMeta(ySyncPluginKey) as Record<string, unknown> | undefined;
    return (
      meta !== undefined &&
      (Object.hasOwn(meta, "binding") || Object.hasOwn(meta, "isChangeOrigin"))
    );
  }

  it("marks the binding's own transaction and leaves a writer command unmarked", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const editor = constructEditor(doc, []);
    const marked: boolean[] = [];
    editor.on("transaction", ({ transaction }) => marked.push(carriesBindingMeta(transaction)));

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "paragraph", "remote valid prose"),
      "remote-provider-origin",
    );
    await finishFlush();

    expect(marked).toContain(true);

    marked.length = 0;
    expect(editor.commands.deleteRange({ from: 1, to: 7 })).toBe(true);
    await finishFlush();

    expect(marked).toEqual([false]);
  });
});
