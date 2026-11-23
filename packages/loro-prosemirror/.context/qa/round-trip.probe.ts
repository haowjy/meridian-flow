/**
 * Round-trip probe for the shape and the binding (`round-trip.md`). Run from the repo root:
 *   pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/round-trip.probe.ts
 * Exits non-zero on the first failed check, printing it.
 */
import {
  applyOps,
  decodeEnvelope,
  decodeRoomVersion,
  encodeEnvelope,
  encodeRoomVersion,
  freshPeerId,
  RoomDocs,
  readDocument,
  STRUCTURE_KEY,
  sameValue,
  setCommentBody,
  writeDocument,
} from "@meridian/document-model";
import { createMemoryDocumentRooms } from "@meridian/document-model/rooms";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, newBlockId, withBlockIds } from "@meridian/prosemirror-schema";
import {
  CrdtType,
  decode as decodeFrame,
  encode as encodeFrame,
  MessageType,
} from "loro-protocol";
import type { Node } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import {
  blocksOf,
  heldUpdateCount,
  importRemoteUpdate,
  loroSyncPlugin,
  readProseMirror,
  shapeSchemaOf,
  writeProseMirror,
} from "../../src/index.js";

const schema = buildDocumentSchema();
const shape = shapeSchemaOf(schema);
const codec = mdxCodec({
  schema,
  components: {
    StatBlock: { name: "StatBlock", kind: "leaf", children: "none", props: { value: { type: "number", required: true } } },
    Panel: { name: "Panel", kind: "container", children: "block", props: { title: { type: "string", required: true } } },
  },
});

const owned: RoomDocs[] = [];
const track = (docs: RoomDocs) => (owned.push(docs), docs);
let checks = 0;
function check(name: string, ok: boolean, detail?: () => unknown) {
  checks++;
  if (ok) return;
  process.stderr.write(`FAIL ${name}\n`);
  if (detail) process.stderr.write(`${JSON.stringify(detail(), null, 1).slice(0, 4000)}\n`);
  process.exitCode = 1;
  throw new Error(name);
}

const fromMarkdown = (source: string): Node =>
  withBlockIds(schema.topNodeType.create(null, codec.parse(source).blocks));

/** `doc` with a comment on the text range [from, to) of the `n`th textblock. */
function comment(doc: Node, n: number, from: number, to: number, id: string): Node {
  let seen = 0;
  let start = -1;
  doc.descendants((node, pos) => {
    if (start >= 0) return false;
    if (node.isTextblock && seen++ === n) start = pos + 1;
    return true;
  });
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.addMark(start + from, start + to, schema.marks.comment.create({ id }))).doc;
}

const fixtures: Record<string, () => { doc: Node; comments?: string[] }> = {
  empty: () => ({ doc: withBlockIds(schema.topNodeType.create(null, [schema.nodes.paragraph.create()])) }),
  prose: () => ({
    doc: fromMarkdown(
      "# Chapter One\n\nThe **bold** and *em* and `code` and ~~strike~~ and [a link](https://example.com \"t\").\n\n## Part\n\nLine one  \nline two after a hard break. CJK 中文字 and emoji 😀 here.\n\n---\n\nEnd.",
    ),
  }),
  lists: () => ({
    doc: fromMarkdown(
      "- one\n- two\n  - nested a\n  - nested b\n- three\n\n3. third\n4. fourth\n\n> quoted\n> - quoted item\n\n- [ ] task",
    ),
  }),
  table: () => ({
    doc: fromMarkdown(
      "| Left | Center | Right |\n|:--|:-:|--:|\n| a **b** | | c |\n| ![img](https://x.test/i.png) | two | three |",
    ),
  }),
  code: () => ({ doc: fromMarkdown("```ts\nconst a = 1;\n\nconst b = `x`;\n```\n\nAfter `inline` code.") }),
  images: () => ({ doc: fromMarkdown("Text ![alt one](https://x.test/a.png \"title\") between ![](https://x.test/b.png) end.\n\n![figure-ish](https://x.test/c.png)") }),
  jsx: () => ({
    doc: fromMarkdown(
      '<Panel title="Stats">\n\nInside **panel**.\n\n<StatBlock value={3} />\n\n</Panel>\n\nAfter the panel.',
    ),
  }),
  comments: () => {
    let doc = fromMarkdown("A comment over words here, and **another** that overlaps.\n\nImage ![pic](https://x.test/p.png) with a note.");
    doc = comment(doc, 0, 2, 9, "c1");
    doc = comment(doc, 0, 5, 30, "c2");
    doc = comment(doc, 1, 6, 9, "c3");
    return { doc, comments: ["c1", "c2", "c3"] };
  },
};

function seed(doc: Node, comments: string[] = []): RoomDocs {
  const docs = track(RoomDocs.create(shape, freshPeerId()));
  for (const id of comments) setCommentBody(docs, id, { body: `body ${id}`, author: "u", resolved: false });
  writeProseMirror(docs, doc, { message: "seed" });
  return docs;
}

const show = (doc: Node) => {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.isText) out.push(`${JSON.stringify(node.text)}[${node.marks.map((m) => m.type.name + (m.attrs.id ? `:${m.attrs.id}` : "")).join(",")}]`);
    else out.push(`<${node.type.name}${node.attrs.id ? ` ${node.attrs.id}` : ""}>`);
    return true;
  });
  return out;
};

for (const [name, make] of Object.entries(fixtures)) {
  const { doc, comments } = make();
  const live = seed(doc, comments);

  const read = readProseMirror(live, schema);
  check(`${name}: doc -> shape -> PM identity`, read.eq(doc), () => ({ want: show(doc), got: show(read) }));
  check(`${name}: second write is a no-op`, writeProseMirror(live, read).length === 0);

  const batch = encodeEnvelope(live.exportSince());
  const other = track(RoomDocs.create(shape, freshPeerId()));
  other.importBatch(decodeEnvelope(batch));
  check(`${name}: envelope import identity`, readProseMirror(other, schema).eq(doc));

  const loaded = track(RoomDocs.load(shape, freshPeerId(), live.snapshots()));
  check(`${name}: snapshot load identity`, readProseMirror(loaded, schema).eq(doc));

  const frame = encodeFrame({ type: MessageType.DocUpdate, crdt: CrdtType.Loro, roomId: "live:doc1", updates: [batch], batchId: "0x0102030405060708" });
  const decoded = decodeFrame(frame);
  check(
    `${name}: DocUpdate carries the envelope undecoded`,
    decoded.type === MessageType.DocUpdate && sameBytes(decoded.updates[0], batch),
  );
  const version = encodeRoomVersion(live.version());
  const join = decodeFrame(
    encodeFrame({ type: MessageType.JoinRequest, crdt: CrdtType.Loro, roomId: "live:doc1", auth: new Uint8Array([1, 2]), version }),
  );
  check(
    `${name}: JoinRequest carries the room version undecoded`,
    join.type === MessageType.JoinRequest && sameBytes(join.version, version) && decodeRoomVersion(join.version).size === live.version().size,
  );

  // A draft fork reads Live, writes only overrides and forked text docs, and leaves Live alone.
  const draft = track(RoomDocs.draftOf(live, freshPeerId()));
  check(`${name}: fresh draft reads Live`, readProseMirror(draft, schema).eq(doc));
  const liveBefore = live.structure.oplogVersion();
  const edited = editFirstText(read, " (draft)");
  writeProseMirror(draft, edited, { message: "draft" });
  check(`${name}: draft shows its edit`, readProseMirror(draft, schema).eq(edited), () => ({ want: show(edited), got: show(readProseMirror(draft, schema)) }));
  check(`${name}: Live untouched by the draft`, live.structure.oplogVersion().compare(liveBefore) === 0 && readProseMirror(live, schema).eq(doc));
  check(
    `${name}: draft wrote no base key`,
    ["parent", "order", "node", "attrs", "comments"].every((m) =>
      sameValue(draft.structure.getMap(m).toJSON(), live.structure.getMap(m).toJSON()),
    ),
  );
  // Writing Live's content back into the draft deletes its overrides (matching overrides are dropped).
  writeProseMirror(draft, doc, { message: "back" });
  check(`${name}: draft back to Live content shows Live`, readProseMirror(draft, schema).eq(doc));
  check(
    `${name}: no override left after writing Live's content`,
    ["d.parent", "d.order", "d.node", "d.attrs", "d.comments"].every((m) => draft.structure.getMap(m).size === 0),
    () => Object.fromEntries(["d.parent", "d.order", "d.node", "d.attrs"].map((m) => [m, draft.structure.getMap(m).toJSON()])),
  );
}

function editFirstText(doc: Node, suffix: string): Node {
  let end = -1;
  doc.descendants((node, pos) => {
    if (end < 0 && node.isTextblock) end = pos + 1 + node.content.size;
    return end < 0;
  });
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.insertText(suffix, end)).doc;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Concurrent writers: structure moves, removal, restore, the virtual empty paragraph.
{
  const base = fromMarkdown("One.\n\nTwo.\n\nThree.\n\n| a | b |\n|--|--|\n| x | y |");
  const a = seed(base);
  const b = track(RoomDocs.create(shape, freshPeerId()));
  b.importBatch(a.exportSince());
  const blocks = readDocument(a);
  // a moves "Three." to the top; b retypes "Two." as a heading and types in it.
  writeDocument(a, [blocks[2], blocks[0], blocks[1], blocks[3]]);
  const bBlocks = readDocument(b);
  const two = bBlocks[1];
  if (two.kind !== "text") throw new Error("fixture");
  writeDocument(b, [bBlocks[0], { ...two, attrs: { ...two.attrs, level: 2 }, inline: [{ kind: "text", text: "Two, typed.", marks: {} }] }, bBlocks[2], bBlocks[3]]);
  const fromA = a.exportSince(b.version());
  const fromB = b.exportSince(a.version());
  a.importBatch(fromB);
  b.importBatch(fromA);
  const ra = readProseMirror(a, schema);
  check("concurrent move and retype converge", ra.eq(readProseMirror(b, schema)));
  check(
    "concurrent move and retype both land",
    ra.child(0).textContent === "Three." && ra.child(2).attrs.level === 2 && ra.child(2).textContent === "Two, typed.",
    () => show(ra),
  );
  // An emptied cell reads one unstored empty paragraph with a derived id; writing it back stores nothing.
  const current = readDocument(a);
  const table = current.find((x) => x.node === "table");
  if (!table || table.kind !== "container") throw new Error("fixture");
  const row = table.children[1];
  if (row.kind !== "container") throw new Error("fixture");
  const cell = row.children[0];
  if (cell.kind !== "container") throw new Error("fixture");
  const others = current.filter((x) => x !== table);
  writeDocument(a, [...others, { ...table, children: [table.children[0], { ...row, children: [{ ...cell, children: [] }, row.children[1]] }] }]);
  const after = readDocument(a).find((x) => x.node === "table");
  const filled = after?.kind === "container" && after.children[1]?.kind === "container" ? after.children[1].children[0] : null;
  check(
    "empty cell shows the derived empty paragraph",
    filled?.kind === "container" && filled.children[0]?.id === `${cell.id}/empty`,
    () => after,
  );
  const v = a.structure.oplogVersion();
  writeProseMirror(a, readProseMirror(a, schema));
  check("write-back of the filled cell writes nothing", a.structure.oplogVersion().compare(v) === 0);
}

// The sentinel and code rules on merged states.
{
  const live = seed(fromMarkdown("plain text here"));
  const p = readDocument(live)[0];
  if (p.kind !== "text") throw new Error("fixture");
  const text = live.textOf(p.id)?.getText("t");
  text?.mark({ start: 0, end: 5 }, "code", {});
  text?.mark({ start: 0, end: 3 }, "strong", {});
  text?.mark({ start: 6, end: 8 }, "inline", { type: "image", attrs: { src: "x" } } as never);
  text?.insert(0, "￼");
  live.textOf(p.id)?.commit();
  const nodes = readProseMirror(live, schema).child(0);
  const first = nodes.child(0);
  check("U+FFFC without inline style reads as text", first.isText && (first.text ?? "").startsWith("￼"));
  let codeAlone = true;
  nodes.forEach((n) => {
    if (n.marks.some((m) => m.type.name === "code") && n.marks.length > 1) codeAlone = false;
  });
  check("code shows alone", codeAlone);
  check("inline style off the sentinel is ignored", !nodes.content.content.some((n) => n.type.name === "image"));
  const v = live.textOf(p.id)?.oplogVersion();
  writeProseMirror(live, readProseMirror(live, schema));
  check("write-back of normalized marks writes nothing", live.textOf(p.id)?.oplogVersion().compare(v as never) === 0);
  // A hidden comment (no body) shows nothing and survives a write of its block.
  text?.mark({ start: 9, end: 12 }, "comment_ghost", true);
  live.textOf(p.id)?.commit();
  check(
    "comment without a body shows nothing",
    !readProseMirror(live, schema).child(0).content.content.some((n) => n.marks.some((m) => m.type.name === "comment")),
  );
  writeProseMirror(live, editFirstText(readProseMirror(live, schema), "!"));
  setCommentBody(live, "ghost", { body: "late", author: "u", resolved: false });
  check(
    "a body arriving later shows the kept mark",
    readProseMirror(live, schema).child(0).content.content.some((n) => n.marks.some((m) => m.type.name === "comment" && m.attrs.id === "ghost")),
  );
}

// applyOps on the shape: a text splice with an inline node, a format, an insert, a delete, attrs.
{
  const live = seed(fromMarkdown("First paragraph.\n\nSecond one.\n\nThird."));
  const [p1, p2, p3] = readDocument(live);
  const result = applyOps(
    live,
    [
      {
        kind: "text",
        block: p1.id,
        splices: [{ from: 6, to: 15, content: [{ kind: "text", text: "line", marks: {} }, { kind: "inline", node: "hard_break", attrs: {}, marks: {} }] }],
        formats: [{ from: 0, to: 5, mark: "strong", value: {} }],
      },
      { kind: "attrs", block: p2.id, attrs: { level: 3 } },
      { kind: "insert", parent: null, after: p2.id, blocks: [{ kind: "text", id: "newblock01", node: "paragraph", attrs: {}, inline: [{ kind: "text", text: "Inserted.", marks: { em: {} } }] }] },
      { kind: "delete", block: p3.id },
    ],
    { message: "turn:t1", newBlockId },
  );
  check("applyOps ok", result.ok, () => result);
  const out = readProseMirror(live, schema);
  check(
    "applyOps result",
    out.childCount === 3 &&
      out.child(0).textContent === "First line." &&
      out.child(0).child(0).marks[0]?.type.name === "strong" &&
      out.child(0).content.content.some((n) => n.type.name === "hard_break") &&
      out.child(1).attrs.level === 3 &&
      out.child(2).attrs.id === "newblock01" &&
      out.child(2).child(0).marks[0]?.type.name === "em",
    () => show(out),
  );
  const bad = applyOps(live, [{ kind: "text", block: p1.id, splices: [{ from: 0, to: 999, content: [] }], formats: [] }], { newBlockId });
  check("applyOps refuses an out-of-range splice before writing", !bad.ok);
  check("the change carries the message", result.ok && result.changes.every((c) => c.doc.getChangeAt(c.after[0]).message === "turn:t1"));
}

// The binding: typing on the fast path, structure edits on the full path, a remote batch held during
// composition and imported after.
{
  const live = seed(fromMarkdown("Hello world.\n\nSecond."));
  const tab = track(RoomDocs.create(shape, freshPeerId()));
  tab.importBatch(live.exportSince());
  let state = EditorState.create({ schema, doc: readProseMirror(tab, schema), plugins: [loroSyncPlugin({ docs: tab, newBlockId })] });
  const textVersion = () => tab.textOf(readDocument(tab)[0].id)?.oplogVersion();
  const structureBefore = tab.structure.oplogVersion();
  state = state.apply(state.tr.insertText("!", 12));
  check("typing reaches the text doc", readProseMirror(tab, schema).eq(state.doc), () => ({ want: show(state.doc), got: show(readProseMirror(tab, schema)) }));
  check("typing writes no structure op", tab.structure.oplogVersion().compare(structureBefore) === 0);
  state = state.apply(state.tr.addMark(1, 6, schema.marks.strong.create()));
  check("a mark reaches the text doc", readProseMirror(tab, schema).eq(state.doc));
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7)).insertText("big ", 7));
  check("typing after bold stays plain", readProseMirror(tab, schema).eq(state.doc), () => show(readProseMirror(tab, schema)));
  const split = state.tr.split(4);
  split.setNodeAttribute(split.doc.resolve(split.mapping.map(4)).before(), "id", "splitblock");
  state = state.apply(split);
  check("a split reaches the shape", readProseMirror(tab, schema).eq(state.doc), () => ({ want: show(state.doc), got: show(readProseMirror(tab, schema)) }));
  check("typing changed the text doc", textVersion() !== undefined);
  // A remote batch imports through the guard and reads into the shape.
  const liveBlocks = readDocument(live);
  const last = liveBlocks[1];
  if (last.kind !== "text") throw new Error("fixture");
  live.importBatch(tab.exportSince(live.version()));
  writeDocument(live, [...readDocument(live).slice(0, -1), { ...last, inline: [{ kind: "text", text: "Second, remote.", marks: {} }] }]);
  const status = importRemoteUpdate(tab, encodeEnvelope(live.exportSince(tab.version())), () => {});
  check("remote import is not held without a composition", status !== null);
  check("remote edit reads in the shape", readProseMirror(tab, schema).lastChild?.textContent === "Second, remote.");
}

// The plugin's view half with a stand-in view: a remote batch re-reads only what changed and keeps
// the caret in its block; a batch arriving mid-composition is held until the composition ends.
{
  const live = seed(fromMarkdown("Alpha beta.\n\nGamma."));
  const tab = track(RoomDocs.create(shape, freshPeerId()));
  tab.importBatch(live.exportSince());
  const writes: number[] = [];
  const plugin = loroSyncPlugin({ docs: tab, newBlockId, onLocalWrite: (changes) => writes.push(changes.length) });
  const view = {
    state: EditorState.create({ schema, doc: readProseMirror(tab, schema), plugins: [plugin] }),
    composing: false,
    isDestroyed: false,
    dom: new EventTarget(),
    dispatch(tr: import("prosemirror-state").Transaction) {
      this.state = this.state.apply(tr);
      handle.update?.(view as never, this.state);
    },
  };
  const handle = plugin.spec.view?.(view as never) ?? {};
  // Caret after "Alpha" in the first paragraph.
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
  const first = readDocument(tab)[0];
  const textDoc = tab.textOf(first.id);
  const counter = () => textDoc?.oplogVersion().get(tab.peer) ?? 0;
  // Typing inside bold writes one op per character and no style op.
  view.dispatch(view.state.tr.addMark(1, 6, schema.marks.strong.create()));
  const c0 = counter();
  view.dispatch(view.state.tr.insertText("x", 3));
  check("typing inside bold is one op", counter() - c0 === 1, () => counter() - c0);
  check("typing is one doc change (fast path)", writes.at(-1) === 1);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
  // A peer types at the start of the caret's paragraph.
  const peer = track(RoomDocs.create(shape, freshPeerId()));
  peer.importBatch(tab.exportSince());
  const peerFirst = readDocument(peer)[0];
  if (peerFirst.kind !== "text") throw new Error("fixture");
  writeDocument(peer, [{ ...peerFirst, inline: [{ kind: "text", text: "Remote ", marks: {} }, ...peerFirst.inline] }, ...readDocument(peer).slice(1)]);
  importRemoteUpdate(tab, encodeEnvelope(peer.exportSince(tab.version())), () => {});
  check("remote batch reaches the editor", view.state.doc.eq(readProseMirror(tab, schema)), () => ({ want: show(readProseMirror(tab, schema)), got: show(view.state.doc) }));
  check("caret stays after the same character", view.state.selection.head === 7 + "Remote ".length, () => view.state.selection.head);
  check("the binding's own transaction wrote nothing back", writes.length === 2);
  // Mid-composition: held, then released on compositionend.
  view.composing = true;
  const gamma = readDocument(peer)[1];
  if (gamma.kind !== "text") throw new Error("fixture");
  peer.importBatch(tab.exportSince(peer.version()));
  writeDocument(peer, [readDocument(peer)[0], { ...gamma, inline: [{ kind: "text", text: "Gamma, held.", marks: {} }] }]);
  const held = importRemoteUpdate(tab, encodeEnvelope(peer.exportSince(tab.version())), () => {});
  check("a batch mid-composition is held", held === null && heldUpdateCount(tab) === 1 && view.state.doc.lastChild?.textContent === "Gamma.");
  check("held bytes are not in the docs yet", readProseMirror(tab, schema).lastChild?.textContent === "Gamma.");
  view.composing = false;
  view.dom.dispatchEvent(new Event("compositionend"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  check("released after the composition", heldUpdateCount(tab) === 0 && view.state.doc.lastChild?.textContent === "Gamma, held.");
  handle.destroy?.();
}

// A Draft editor: typing forks the block's text doc (Live untouched), and a Live batch imported into
// the tab's Live copy is forwarded into the fork and shown.
{
  const live = seed(fromMarkdown("Draft me.\n\nLive edits this."));
  const tabLive = track(RoomDocs.create(shape, freshPeerId()));
  tabLive.importBatch(live.exportSince());
  const tabDraft = track(RoomDocs.draftOf(tabLive, freshPeerId()));
  const plugin = loroSyncPlugin({ docs: tabDraft, newBlockId });
  const view = {
    state: EditorState.create({ schema, doc: readProseMirror(tabDraft, schema), plugins: [plugin] }),
    composing: false,
    isDestroyed: false,
    dom: new EventTarget(),
    dispatch(tr: import("prosemirror-state").Transaction) {
      this.state = this.state.apply(tr);
    },
  };
  const handle = plugin.spec.view?.(view as never) ?? {};
  const [first, second] = readDocument(tabDraft);
  const liveFirst = tabLive.textOf(first.id)?.oplogVersion();
  view.dispatch(view.state.tr.insertText(" Now.", 10));
  check("draft typing forks the block", tabDraft.texts.has(first.id));
  check("draft typing leaves Live's doc alone", tabLive.textOf(first.id)?.oplogVersion().compare(liveFirst as never) === 0);
  check("draft shows its typing", readProseMirror(tabDraft, schema).eq(view.state.doc));
  if (second.kind !== "text") throw new Error("fixture");
  writeDocument(live, [readDocument(live)[0], { ...second, inline: [{ kind: "text", text: "Live edited this.", marks: {} }] }]);
  importRemoteUpdate(tabLive, encodeEnvelope(live.exportSince(tabLive.version())), () => {});
  check("a Live batch shows in the Draft editor", view.state.doc.lastChild?.textContent === "Live edited this.", () => show(view.state.doc));
  check("and keeps the draft's own typing", view.state.doc.firstChild?.textContent === "Draft me. Now.");
  handle.destroy?.();
}

// The in-memory rooms: write, subscribe, commit after the transaction, a fork room forwarded.
{
  const rooms = createMemoryDocumentRooms(shape);
  const room = { kind: "live", documentId: "doc1" } as const;
  const fork = { kind: "fork", draftId: "draftdraft01", documentId: "doc1" } as const;
  const source = seed(fromMarkdown("Room text."));
  await rooms.transaction((tx) => rooms.seed(tx, room, encodeEnvelope(source.snapshots())));
  const heard: string[] = [];
  rooms.subscribe(room, (b) => heard.push(b.origin));
  const copy = track(await rooms.read(room));
  check("room read after seed", readProseMirror(copy, schema).eq(readProseMirror(source, schema)));
  const draftRead = track(await rooms.read(fork));
  check("fork room reads Live before any draft write", readProseMirror(draftRead, schema).eq(readProseMirror(source, schema)));
  writeProseMirror(copy, editFirstText(readProseMirror(copy, schema), " Typed."));
  await rooms.write(room, encodeEnvelope(copy.exportSince(decodeRoomVersion((await rooms.sync(room, new Uint8Array())).version))), "socket:1");
  check("write is heard by subscribers", heard.includes("socket:1"));
  const forked = track(await rooms.read(fork));
  check("a fork room loaded is forwarded to Live", readProseMirror(forked, schema).child(0).textContent.endsWith(" Typed."));
  const cmd = track(await rooms.read(room));
  writeProseMirror(cmd, editFirstText(readProseMirror(cmd, schema), " Pressed."), { message: "press:x" });
  const pending = encodeEnvelope(cmd.exportSince(copy.version()));
  let sawBeforeCommit = false;
  await rooms.transaction(async (tx) => {
    await rooms.commit(tx, room, pending, "server:press");
    sawBeforeCommit = heard.includes("server:press");
  });
  check("a commit imports only after its transaction", !sawBeforeCommit && heard.includes("server:press"));
  check("a commit's rows are stored", (rooms.rows().get("live:doc1")?.size ?? 0) > 0);
  await rooms.close();
  check("close unloads every room", rooms.loaded().length === 0);
  const reloaded = track(await rooms.read(room));
  check("reload from rows has the commit", readProseMirror(reloaded, schema).child(0).textContent.endsWith(" Pressed."));
  check("structure key is s", STRUCTURE_KEY === "s");
  await rooms.close();
}

for (const docs of owned) docs.free();
process.stdout.write(`ok: ${checks} checks, ${Object.keys(fixtures).length} fixtures\n`);
void blocksOf;
