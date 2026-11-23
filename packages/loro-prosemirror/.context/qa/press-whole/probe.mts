// Shared setup for the press-whole probes (`README.md`): run each with
//   pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/press-whole/<probe>.mts
const W = new URL("../../../../../", import.meta.url).pathname;
const PM = W + "node_modules/.pnpm/@tiptap+pm@3.34.0/node_modules/@tiptap/pm/dist";
const dm = await import(W + "packages/document-model/src/index.ts");
const lp = await import(W + "packages/loro-prosemirror/src/index.ts");
const sch = await import(W + "packages/prosemirror-schema/src/index.ts");
const { fixBlockIds } = await import(W + "apps/app/src/core/editor/extensions/block-id/fix-block-ids.ts");
const { EditorState, TextSelection } = await import(PM + "/state/index.js");
const cmds = await import(PM + "/commands/index.js");
const { Slice, Fragment } = await import(PM + "/model/index.js");
const { RoomDocs, changedBlocks, applyBlocks, discardBlocks, StructureView } = dm;
const schema = sch.buildDocumentSchema();
const shape = lp.shapeSchemaOf(schema);
const read = (d) => lp.readProseMirror(d, schema);
let peer = 10;
function setup(texts) {
  const live = RoomDocs.create(shape, "1");
  const p = (t, i) => schema.nodes.paragraph.create({ id: "P" + i }, t ? schema.text(t) : undefined);
  const doc = schema.nodes.doc.create(null, texts.map(p));
  lp.writeProseMirror(live, doc, { message: "init" });
  const draft = RoomDocs.draftOf(live, String(++peer));
  return { live, draft };
}
function edit(d, fn) {
  const state = EditorState.create({ schema, doc: read(d) });
  let tr = fn(state);
  if (!tr || !tr.docChanged) return null;
  fixBlockIds(tr, state);
  const moved = lp.movedPieces(tr);
  lp.writeProseMirror(d, tr.doc, { previous: state.doc, moved });
  return moved.pieces;
}
function cmd(c, from, to = from) {
  return (state) => {
    let s = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
    let out = null;
    c(s, (tr) => (out = tr));
    if (!out) return null;
    const tr = state.tr;
    for (const st of out.steps) tr.step(st);
    return tr;
  };
}
const posOf = (doc, id, off = 0) => { let r = -1; doc.descendants((n, p) => { if (n.attrs?.id === id) r = p + 1 + off; return r < 0; }); return r; };
const show = (d) => { const o = []; read(d).descendants((n) => { if (n.isTextblock) { o.push(`${n.attrs.id}:${n.textContent}`); return false; } return true; }); return o.join(" | "); };
const pieces = (d) => new StructureView(d).overrideKeys("pieces");
const groups = (d) => JSON.stringify(changedBlocks(d).map((c) => c.blocks));
function report(name, { live, draft }, extra = "") {
  console.log(`\n== ${name}\n live : ${show(live)}\n draft: ${show(draft)}\n pieces: ${JSON.stringify(pieces(draft))}\n changes: ${groups(draft)} ${extra}`);
}
export { setup, edit, cmd, posOf, show, report, pieces, groups, cmds, schema, Slice, Fragment, read, applyBlocks, discardBlocks, changedBlocks, TextSelection, EditorState, dm, lp, RoomDocs, StructureView };
