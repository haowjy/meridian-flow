// @vitest-environment jsdom
/**
 * The review's paint: where a hunk's green and red land in the editor, and the two risks that make the
 * review lie: a removal drawn at the wrong block boundary, and a review repainted from a stale base.
 */
import {
  appendApplyRecord,
  readRestorations,
  recordRestorations,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { DraftAttribution } from "@meridian/contracts/drafts";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { QueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as draftsApi from "@/client/api/drafts-api";
import { draftAttributionQueryOptions } from "@/client/query/useDraftAttribution";
import { createReviewRuntime, type ReviewRuntime } from "@/features/draft-review/review-runtime";
import { useArrivedChanges } from "@/features/draft-review/useArrivedChanges";
import {
  attachReviewRuntime,
  createReviewEditor,
  destroyReviewEditors,
  seedReviewBase,
} from "@/test-support/inline-review-editor";
import { getInlineReviewPluginState } from "./DraftInlineReviewExtension";
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
  vi.unstubAllGlobals();
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

it("retains mark and removal DOM while typing inside a change and changing emphasis", () => {
  const { editor, projector } = reviewing(["The door is red."], ["The door is green."]);
  const mark = editor.view.dom.querySelector(`.${inlineReviewClassNames.added}`);
  const removal = removals(editor)[0];
  editor.commands.setTextSelection(15);
  const input = new InputEvent("beforeinput", {
    inputType: "insertText",
    data: "x",
    bubbles: true,
    cancelable: true,
  });
  // jsdom has no native target-range implementation.
  Object.defineProperty(input, "getTargetRanges", { value: () => [] });
  editor.view.dom.dispatchEvent(input);
  expect(input.defaultPrevented).toBe(true);
  expect(editor.state.doc.textContent).toBe("The door is grxeen.");
  projector.projectNow();
  expect(editor.view.dom.querySelector(`.${inlineReviewClassNames.added}`)).toBe(mark);
  expect(removals(editor)[0]).toBe(removal);
  const id = mark?.getAttribute("data-review-change") ?? null;
  editor.commands.setReviewActiveChange(id);
  expect(editor.view.dom.querySelector(`.${inlineReviewClassNames.added}`)).toBe(mark);
  expect(removals(editor)[0]).toBe(removal);
  expect(mark?.classList.contains(inlineReviewClassNames.emphasized)).toBe(true);
});

it("defers projected paint during composition and consumes a pulse at the DOM only once", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { editor, projector } = reviewing(["The door is red."], ["The door is green."]);
  const root = editor.view.dom;
  const mark = root.querySelector(`.${inlineReviewClassNames.added}`);
  const removal = removals(editor)[0];
  root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  editor.commands.insertContentAt(15, "x");
  const mapped = getInlineReviewPluginState(editor.state)?.decorations;
  projector.projectNow();
  expect(getInlineReviewPluginState(editor.state)?.decorations).toBe(mapped);
  expect(root.querySelector(`.${inlineReviewClassNames.added}`)).toBe(mark);
  expect(removals(editor)[0]).toBe(removal);
  root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  vi.advanceTimersByTime(25);
  const id = mark?.getAttribute("data-review-change");
  if (!id || !mark) throw new Error("Missing painted change");
  editor.commands.setReviewPulse([id]);
  expect(mark.classList.contains(inlineReviewClassNames.arrived)).toBe(true);
  mark.dispatchEvent(new Event("animationend", { bubbles: true }));
  expect(mark.classList.contains(inlineReviewClassNames.arrived)).toBe(false);
  projector.projectNow();
  editor.commands.setReviewActiveChange(id);
  editor.commands.setReviewPulse([id]);
  expect(root.querySelector(`.${inlineReviewClassNames.added}`)).toBe(mark);
  expect(mark.classList.contains(inlineReviewClassNames.arrived)).toBe(false);
  editor.commands.setReviewMarksVisible(false);
  editor.commands.setReviewMarksVisible(true);
  expect(root.querySelector(`.${inlineReviewClassNames.arrived}`)).toBeNull();
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
it("an attached runtime receives atomic Undo provenance and refreshes a later Apply record", async () => {
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
  recordRestorations(history);
  peer.transact(() => {
    const t = (peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    t.delete(10, 4);
  }, origin);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  const updates: Array<{ update: Uint8Array; origin: unknown }> = [];
  peer.on("update", (update, origin) => updates.push({ update, origin }));
  history.undo();
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
    expect(updates).toHaveLength(1);
    Y.applyUpdate(doc, updates[0].update);
    await vi.advanceTimersByTimeAsync(180);
    const frame = runtime.state().frame;
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

it("drains a cold read overtaken by a peer revision, and makes an uncovered fence retryable", async () => {
  vi.useFakeTimers();
  const schema = buildDocumentSchema();
  const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  writeBlocks(doc.getXmlFragment("prosemirror"), schema, [p("alpha tail")]);
  seedReviewBase(doc, ["alpha tail"]);
  doc.clientID = 900;
  const stale: DraftAttribution = {
    itemKey: "cold",
    userId: "u",
    revision: [...Y.encodeSnapshot(Y.snapshot(doc))],
    edits: [],
  };
  let resolve!: (value: DraftAttribution) => void;
  const held = new Promise<DraftAttribution>((done) => {
    resolve = done;
  });
  const current = () => ({ ...stale, revision: [...Y.encodeSnapshot(Y.snapshot(doc))] });
  const api = vi
    .spyOn(draftsApi, "getDraftAttribution")
    .mockReturnValueOnce(held)
    .mockImplementation(async () => current());
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const runtime = createReviewRuntime(
    {
      document: doc,
      subscribe: () => () => {},
      getSnapshot: () => ({ status: "synced" }),
      whenSynced: () => Promise.resolve(),
      hasUnacknowledgedEdits: () => false,
    } as never,
    {
      draft: { projectId: "p", workId: "w", documentId: "cold", itemKey: "cold" },
      queryClient: client,
    },
  );
  const peer = new Y.Doc({ gc: false });
  try {
    await vi.advanceTimersByTimeAsync(180);
    expect(api).toHaveBeenCalledTimes(1);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.clientID = 901;
    writeBlocks(peer.getXmlFragment("prosemirror"), schema, [p("alpha tail WRITER")]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    await vi.advanceTimersByTimeAsync(180);
    expect(runtime.state().membership.status).toBe("loading");
    expect(runtime.state().changes[0].byline).toEqual([]);
    resolve(stale);
    await vi.advanceTimersByTimeAsync(180);
    expect(api).toHaveBeenCalledTimes(2);
    expect(runtime.state().membership.status).toBe("ready");
    expect(runtime.state().changes[0].byline).toEqual([{ kind: "user", userId: "u" }]);

    // The next revision can never be covered by this response. Stop refreshing and offer Retry.
    const behind = current();
    api.mockResolvedValue(behind);
    writeBlocks(peer.getXmlFragment("prosemirror"), schema, [p("alpha tail WRITER AGAIN")]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    await vi.advanceTimersByTimeAsync(180);
    const failed = runtime.state().membership;
    expect(failed.status).toBe("failed");
    const attempts = api.mock.calls.length;
    expect(attempts).toBeLessThanOrEqual(5);
    runtime.projectNow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api).toHaveBeenCalledTimes(attempts);
    api.mockImplementation(async () => current());
    if (failed.status !== "failed") throw new Error("Expected retryable membership");
    failed.retry();
    await vi.advanceTimersByTimeAsync(180);
    expect(runtime.state().membership.status).toBe("ready");
    expect(api).toHaveBeenCalledTimes(attempts + 1);
  } finally {
    runtime.destroy();
    client.clear();
    peer.destroy();
    doc.destroy();
  }
});

it("writer typing and Enter neither arrive nor fetch, while a concurrent AI write arrives once", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const schema = buildDocumentSchema();
  const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  writeBlocks(doc.getXmlFragment("prosemirror"), schema, [p("The red door stays.")]);
  seedReviewBase(doc, ["The red door stays."]);
  doc.clientID = 200000;
  writeBlocks(doc.getXmlFragment("prosemirror"), schema, [p("The blue door stays.")]);
  const part = (client: number, turnId: string) => ({
    threadId: "chat",
    turnId,
    toolCallId: turnId,
    title: "Chat",
    at: "2026",
    owner: { threadId: "chat", title: "Chat", reveal: { threadId: "chat", turnId } },
    inserted: [[client, 0, Y.getState(doc.store, client)]] as [number, number, number][],
    deleted: [...Y.snapshot(doc).ds.clients].flatMap(([c, ranges]) =>
      ranges.map(({ clock, len }) => [c, clock, len] as [number, number, number]),
    ),
  });
  let payload: DraftAttribution = {
    itemKey: "typing",
    userId: "u",
    revision: [...Y.encodeSnapshot(Y.snapshot(doc))],
    edits: [part(200000, "initial")],
  };
  doc.clientID = 900;
  const api = vi.spyOn(draftsApi, "getDraftAttribution").mockImplementation(async () => payload);
  const { editor } = createReviewEditor([], doc);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const runtime = createReviewRuntime(
    {
      document: doc,
      subscribe: () => () => {},
      getSnapshot: () => ({ status: "synced" }),
      whenSynced: () => Promise.resolve(),
      hasUnacknowledgedEdits: () => false,
    } as never,
    {
      draft: { projectId: "p", workId: "w", documentId: "typing", itemKey: "typing" },
      queryClient: client,
    },
  );
  let arrived: ReadonlySet<string> = new Set();
  const container = document.createElement("div");
  const root = createRoot(container);
  function ArrivalReader() {
    const state = useSyncExternalStore(runtime.subscribe, runtime.state);
    arrived = useArrivedChanges(state.changes, state.ready, "typing");
    return null;
  }
  await act(async () => {
    root.render(createElement(ArrivalReader));
  });
  const peer = new Y.Doc({ gc: false });
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
  try {
    runtime.attachEditor(editor);
    await settle();
    expect(arrived.size).toBe(0);
    api.mockClear();
    act(() => {
      editor.commands.insertContentAt(7, "X");
    });
    await settle();
    expect.soft(arrived.size).toBe(0);
    expect.soft(api).not.toHaveBeenCalled();
    act(() => {
      editor.commands.setTextSelection(8);
      editor.commands.splitBlock();
    });
    await settle();
    expect.soft(arrived.size).toBe(0);
    expect.soft(api).not.toHaveBeenCalled();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.clientID = 400000;
    const last = peer.getXmlFragment("prosemirror").get(1) as Y.XmlElement;
    const text = last.get(0) as Y.XmlText;
    text.insert(text.length, " A visitor arrives.");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    payload = {
      ...payload,
      revision: [...Y.encodeSnapshot(Y.snapshot(doc))],
      edits: [part(400000, "next"), ...payload.edits],
    };
    act(() => {
      editor.commands.insertContentAt(2, "Y");
    });
    await settle();
    expect(arrived.size).toBe(1);
    const reads = api.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(arrived.size).toBe(0);
    act(() => {
      editor.commands.insertContentAt(3, "Z");
    });
    await settle();
    expect(arrived.size).toBe(0);
    expect(api).toHaveBeenCalledTimes(reads);
  } finally {
    await act(async () => {
      root.unmount();
    });
    runtime.destroy();
    client.clear();
    peer.destroy();
    editor.destroy();
    doc.destroy();
  }
});
