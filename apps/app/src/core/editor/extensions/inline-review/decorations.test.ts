// @vitest-environment jsdom
/**
 * The review's paint: where a hunk's green and red land in the editor, and the two risks that make the
 * review lie: a removal drawn at the wrong block boundary, and a review repainted from a stale base.
 */
import {
  appendApplyRecord,
  RESTORED_ORIGIN,
  RESTORED_ROOT,
  readRestorations,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { DraftAttribution } from "@meridian/contracts/drafts";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { QueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as draftsApi from "@/client/api/drafts-api";
import { draftAttributionQueryOptions } from "@/client/query/useDraftAttribution";
import { createReviewRuntime, type ReviewRuntime } from "@/features/draft-review/review-runtime";
import {
  attachReviewRuntime,
  createReviewEditor,
  destroyReviewEditors,
  seedReviewBase,
} from "@/test-support/inline-review-editor";
import { inlineReviewClassNames } from "./decorations";

const projectors: ReviewRuntime[] = [];
function reviewing(base: string[], draft: string[]) {
  const { editor, doc } = createReviewEditor(draft);
  seedReviewBase(doc, base);
  const projector = attachReviewRuntime(editor, doc);
  projectors.push(projector);
  projector.projectNow();
  return { editor, doc, projector };
}

const added = (editor: Editor) =>
  [...editor.view.dom.querySelectorAll(`.${inlineReviewClassNames.added}`)].map(
    (el) => el.textContent,
  );
const removals = (editor: Editor) => [
  ...editor.view.dom.querySelectorAll(`.${inlineReviewClassNames.removal}`),
];

afterEach(() => {
  for (const projector of projectors.splice(0)) projector.destroy();
  destroyReviewEditors();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("hunk placement", () => {
  it("paints inserted words green and the words they replaced red, ahead of the green", () => {
    const { editor } = reviewing(["Alpha beta gamma delta"], ["Alpha BETA gamma delta"]);
    expect(added(editor)).toEqual(["BETA"]);
    const [removal] = removals(editor);
    expect(removal?.textContent).toBe("beta");
    // Red then green: the widget is the green mark's previous sibling in the paragraph.
    expect(removal?.nextElementSibling?.classList.contains(inlineReviewClassNames.added)).toBe(
      true,
    );
  });

  it("draws a removed paragraph between its neighbours and a new one as a block mark", () => {
    const { editor } = reviewing(
      ["First paragraph stays.", "Second paragraph goes away.", "Third paragraph stays."],
      ["First paragraph stays.", "Third paragraph stays.", "A new closing paragraph."],
    );
    const children = [...editor.view.dom.children];
    const widget = children.find((el) =>
      el.classList.contains(inlineReviewClassNames.removalBlock),
    );
    expect(widget?.textContent).toBe("Second paragraph goes away.");
    // Between the first and the (surviving) third paragraph, not before or after the pair.
    expect(widget?.previousElementSibling?.textContent).toBe("First paragraph stays.");
    expect(widget?.nextElementSibling?.textContent).toBe("Third paragraph stays.");
    const block = editor.view.dom.querySelector(
      `p.${inlineReviewClassNames.added}.${inlineReviewClassNames.block}`,
    );
    expect(block?.textContent).toBe("A new closing paragraph.");
  });
});

describe("the base the review compares against", () => {
  it("repaints from the new base when review_base changes, with no edit in the draft", async () => {
    const { editor, doc } = reviewing(
      ["One two three four five six"],
      ["One TWO three four five six"],
    );
    expect(added(editor)).toEqual(["TWO"]);
    // A rebase advances the base to the writer's text: nothing is left to review.
    seedReviewBase(doc, ["One TWO three four five six"]);
    await Promise.resolve();
    expect(added(editor)).toEqual([]);
    expect(removals(editor)).toHaveLength(0);
    // And a later base that differs again repaints against that base, not the first one.
    seedReviewBase(doc, ["One two three four five SIX"]);
    await Promise.resolve();
    expect(added(editor)).toEqual(["TWO", "six"]);
  });
});

describe("recomputing while the writer types", () => {
  it("keeps the painted marks mapped through the edit and recomputes after the debounce", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { editor } = reviewing(["Alpha beta gamma delta"], ["Alpha BETA gamma delta"]);
    editor.commands.insertContentAt(1, "Oh ");
    expect(added(editor)).toEqual(["BETA"]);
    vi.advanceTimersByTime(119);
    expect(added(editor)).toEqual(["BETA"]);
    vi.advanceTimersByTime(2);
    expect(added(editor).join("")).toContain("Oh");
  });
});

describe("a repaint after the writer's edit", () => {
  it("keeps green on its words when focus repaints before the next projection", () => {
    // Risk: metadata repaints used the projection's old coordinates and threw away the mapped marks.
    const { editor } = reviewing(["The door is red."], ["The door is green."]);
    expect(added(editor)).toEqual(["green"]);
    editor.commands.insertContentAt(1, "PREFIX ");
    editor.commands.setReviewActiveChange("c0");
    expect(added(editor)).toEqual(["green"]);
  });
});

// Root-only updates do not generate editor document transactions.
it("an attached runtime republishes delayed Undo provenance and Apply records without a prose change", async () => {
  vi.useFakeTimers();
  const schema = buildDocumentSchema();
  const p = (s: string) => schema.nodes.paragraph.create(null, schema.text(s));
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  writeBlocks(doc.getXmlFragment("prosemirror"), schema, [p("alpha tail")]);
  seedReviewBase(doc, ["alpha tail"]);
  doc.clientID = 200000;
  writeBlocks(doc.getXmlFragment("prosemirror"), schema, [p("alpha tail END")]);
  const inserted = [[200000, 0, Y.getState(doc.store, 200000)]] as [number, number, number][];
  const payload = {
    itemKey: "draft:provenance",
    revision: [...Y.encodeSnapshot(Y.snapshot(doc))],
    userId: "u",
    edits: [
      {
        threadId: "chat",
        turnId: "turn",
        title: "Chat",
        at: "2026",
        owner: { threadId: "chat", title: "Chat", reveal: { threadId: "chat", turnId: "turn" } },
        inserted,
        deleted: [],
      },
    ],
  };
  const peer = new Y.Doc({ gc: false });
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  peer.clientID = 300000;
  const origin = Symbol("discard");
  const history = new Y.UndoManager(peer.getXmlFragment("prosemirror"), {
    trackedOrigins: new Set([origin]),
  });
  peer.transact(() => {
    const t = (peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    t.delete(10, 4);
  }, origin);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  const updates: Array<{ update: Uint8Array; origin: unknown }> = [];
  peer.on("update", (update, origin) => updates.push({ update, origin }));
  history.undo();
  // Deliberately withhold provenance to exercise an unresolved read independently of Undo's wire framing.
  const original = Y.getItem(peer.store, Y.createID(200000, 0));
  const restored = original.redone;
  if (!restored) throw new Error("Undo did not restore the AI insertion");
  peer.transact(() => {
    peer.getArray(RESTORED_ROOT).push([[restored.client, restored.clock, 4, 200000, 0]]);
  }, RESTORED_ORIGIN);
  const { editor, history: surfaceHistory } = createReviewEditor([], doc);
  const draft = {
    projectId: "p",
    workId: "w",
    documentId: "provenance",
    itemKey: "draft:provenance",
  };
  vi.spyOn(draftsApi, "getDraftAttribution").mockReturnValue(new Promise(() => {}));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData(draftAttributionQueryOptions(draft).queryKey, payload);
  const room = {
    document: doc,
    subscribe: () => () => {},
    getSnapshot: () => ({ status: "synced" }),
    whenSynced: () => Promise.resolve(),
    hasUnacknowledgedEdits: () => false,
  };
  const runtime = createReviewRuntime(room as never, { draft, queryClient: client });
  try {
    runtime.attachEditor(editor);
    await vi.advanceTimersByTimeAsync(180);
    for (const x of updates.filter((x) => x.origin !== RESTORED_ORIGIN))
      Y.applyUpdate(doc, x.update);
    await vi.advanceTimersByTimeAsync(180);
    expect(runtime.state().changes[0]).toMatchObject({
      byline: [],
      members: ["chat"],
    });
    const frame = runtime.state().frame;
    for (const x of updates.filter((x) => x.origin === RESTORED_ORIGIN))
      Y.applyUpdate(doc, x.update);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.state().frame?.doc).toBe(frame?.doc);
    const restoredFrame = runtime.state().frame;
    if (!restoredFrame) throw new Error("Restored frame was not published");
    const seen = Y.createDocFromSnapshot(doc, restoredFrame.snapshot, new Y.Doc({ gc: false }));
    expect(readRestorations(seen).links).toHaveLength(1);
    seen.destroy();
    expect(runtime.state().changes[0]).toMatchObject({
      byline: [{ kind: "thread", threadId: "chat", turnId: "turn" }],
      members: ["chat"],
    });
    doc.clientID = 1;
    appendApplyRecord(doc, { base: inserted, settled: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.state().frame?.doc).toBe(frame?.doc);
    // The old read cannot settle the deletion until its revision catches up.
    client.setQueryData(draftAttributionQueryOptions(draft).queryKey, {
      ...payload,
      revision: [...Y.encodeSnapshot(Y.snapshot(doc))],
    });
    expect(runtime.state().changes[0]).toMatchObject({ byline: [], members: [] });
  } finally {
    runtime.destroy();
    editor.destroy();
    surfaceHistory.undoManager.destroy();
    client.clear();
    history.destroy();
    peer.destroy();
    doc.destroy();
  }
});

it.each([
  "changed prose",
  "same prose",
])("new item IDs refresh attribution even with %s", async (kind) => {
  vi.useFakeTimers();
  const schema = buildDocumentSchema();
  const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  writeBlocks(doc.getXmlFragment("prosemirror"), schema, [p("alpha tail")]);
  seedReviewBase(doc, ["alpha tail"]);
  doc.clientID = 200000;
  writeBlocks(doc.getXmlFragment("prosemirror"), schema, [p("alpha tail END")]);
  const payload = (client: number): DraftAttribution => ({
    itemKey: "stale",
    userId: "u",
    revision: [...Y.encodeSnapshot(Y.snapshot(doc))],
    edits: [
      {
        threadId: "chat",
        turnId: "turn",
        title: "Chat",
        at: "2026",
        owner: { threadId: "chat", title: "Chat", reveal: { threadId: "chat", turnId: "turn" } },
        inserted: [
          [200000, 0, Y.getState(doc.store, 200000)],
          [client, 0, Y.getState(doc.store, client)],
        ],
        deleted: [...Y.snapshot(doc).ds.clients].flatMap(([c, ranges]) =>
          ranges.map(({ clock, len }) => [c, clock, len] as [number, number, number]),
        ),
      },
    ],
  });
  const old = payload(200000);
  let resolve!: (value: DraftAttribution) => void;
  const held = new Promise<DraftAttribution>((done) => {
    resolve = done;
  });
  const api = vi
    .spyOn(draftsApi, "getDraftAttribution")
    .mockResolvedValueOnce(old)
    .mockReturnValue(held);
  const { editor } = createReviewEditor([], doc);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const room = {
    document: doc,
    subscribe: () => () => {},
    getSnapshot: () => ({ status: "synced" }),
    whenSynced: () => Promise.resolve(),
    hasUnacknowledgedEdits: () => false,
  };
  const runtime = createReviewRuntime(room as never, {
    draft: { projectId: "p", workId: "w", documentId: "stale", itemKey: "stale" },
    queryClient: client,
  });
  const peer = new Y.Doc({ gc: false });
  try {
    runtime.attachEditor(editor);
    await vi.advanceTimersByTimeAsync(180);
    expect(runtime.state().changes[0].byline).toEqual([
      { kind: "thread", threadId: "chat", turnId: "turn" },
    ]);
    const group = runtime.state().changes[0].id;
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.clientID = 400000;
    peer.transact(() => {
      writeBlocks(peer.getXmlFragment("prosemirror"), schema, [p("alpha tail JUNK")]);
      writeBlocks(peer.getXmlFragment("prosemirror"), schema, [
        p(kind === "same prose" ? "alpha tail END" : "alpha tail NEW"),
      ]);
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    await vi.advanceTimersByTimeAsync(180);
    expect(api).toHaveBeenCalledTimes(2);
    expect(runtime.state().changes[0].byline).toEqual([]);
    expect(runtime.state().changes[0].members).toEqual(["chat"]);
    expect(runtime.state().membership.status).toBe("loading");
    if (kind === "same prose") expect(runtime.state().changes[0].id).toBe(group);
    resolve(payload(400000));
    await vi.advanceTimersByTimeAsync(180);
    expect(runtime.state().changes[0].byline).toEqual([
      { kind: "thread", threadId: "chat", turnId: "turn" },
    ]);
    expect(runtime.state().membership.status).toBe("ready");
  } finally {
    runtime.destroy();
    client.clear();
    peer.destroy();
    editor.destroy();
    doc.destroy();
  }
});
