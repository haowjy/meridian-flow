import {
  configLoroTextStyle,
  createNodeFromLoroObj,
  type LoroDocType,
  LoroSyncPlugin,
  ROOT_DOC_KEY,
  setCommitOrigin,
  updateLoroToPmState,
} from "@meridian/loro-prosemirror";
import { withBlockIds } from "@meridian/prosemirror-schema";
import { LoroDoc, type LoroList, type LoroMap, type LoroText } from "loro-crdt";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

/** Binding-level checks of the fork's changes, run in the browser on the real schema. */
export async function selfChecks(schema: Schema) {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const host = document.createElement("div");
  document.body.append(host);
  const p = (t: string, marks: PMNode[] = []) =>
    schema.nodes.paragraph.create(null, marks.length ? marks : t ? schema.text(t) : null);
  const docOf = (...blocks: PMNode[]) => withBlockIds(schema.nodes.doc.create(null, blocks));
  const loroDoc = (content?: PMNode) => {
    const d = new LoroDoc();
    configLoroTextStyle(d, schema);
    if (content)
      updateLoroToPmState(
        d as LoroDocType,
        new Map(),
        EditorState.create({ schema, doc: content }),
      );
    return d;
  };
  const mount = (d: LoroDoc, doc?: PMNode) => {
    const el = document.createElement("div");
    host.append(el);
    return new EditorView(el, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [LoroSyncPlugin({ doc: d as LoroDocType })],
      }),
    });
  };
  const read = (d: LoroDoc) =>
    createNodeFromLoroObj(schema, (d as LoroDocType).getMap(ROOT_DOC_KEY), new Map());
  const out: Record<string, unknown> = {};

  // #77: a dispatch before init must not wipe imported content.
  {
    const d = loroDoc(docOf(p("Para 1"), p("Para 2"), p("Para 3")));
    const view = mount(d);
    view.dispatch(view.state.tr.insertText("X", 1));
    await tick();
    out.preInitDispatchKeepsContent =
      read(d).textContent === "Para 1Para 2Para 3" &&
      view.state.doc.textContent === "Para 1Para 2Para 3";
    view.destroy();
  }

  // #77 follow-up: an empty Loro document under an editor with content is seeded, not cleared.
  {
    const d = loroDoc();
    const view = mount(d, docOf(p("seeded")));
    await tick();
    out.emptyDocSeededFromEditor =
      read(d).textContent === "seeded" && view.state.doc.textContent === "seeded";
    view.destroy();
  }

  // Block id pairing: dragging block 0 below blocks 1–3 re-creates only block 0; the others keep their containers.
  {
    const content = docOf(p("zero"), p("one"), p("two"), p("three"));
    const d = loroDoc(content);
    const view = mount(d);
    await tick();
    const ids = () => {
      const kids = (d as LoroDocType).getMap(ROOT_DOC_KEY).get("children") as LoroList;
      return kids.toArray().map((m) => ({
        id: (m as LoroMap).id,
        block: ((m as LoroMap).get("attributes") as LoroMap).get("id"),
      }));
    };
    const before = ids();
    const first = view.state.doc.child(0);
    const tr = view.state.tr.delete(0, first.nodeSize);
    tr.insert(tr.doc.content.size, first);
    view.dispatch(tr);
    const after = ids();
    const kept = (i: number) => after.find((a) => a.block === before[i].block)?.id === before[i].id;
    out.dragRecreatesOnlyMovedBlock =
      !kept(0) && kept(1) && kept(2) && kept(3) && read(d).textContent === "onetwothreezero";
    view.destroy();
  }

  // Comments: two comments on the same words are two style keys and both survive; a comment on a hard break (#88) round-trips.
  {
    const c = (id: string) => schema.marks.comment.create({ id });
    const content = docOf(
      schema.nodes.paragraph.create(null, [
        schema.text("plain "),
        schema.text("both", [c("w1"), c("ai2")]),
        schema.nodes.hard_break.create(null, null, [c("hb")]),
        schema.text(" end", [schema.marks.strong.create()]),
      ]),
    );
    const d = loroDoc(content);
    const peer = new LoroDoc();
    configLoroTextStyle(peer, schema);
    peer.import(d.export({ mode: "snapshot" }));
    const back = read(peer);
    const json = JSON.stringify((d as LoroDocType).getMap(ROOT_DOC_KEY).toJSON());
    out.twoCommentsOneWordSurvive = back.eq(content);
    const para = ((d as LoroDocType).getMap(ROOT_DOC_KEY).get("children") as LoroList).get(
      0,
    ) as LoroMap;
    const text = (para.get("children") as LoroList).get(0) as LoroText;
    out.commentStyles = text.toDelta().map((r) => r.attributes ?? {});
    out.commentOnHardBreakStored = json.includes('"marks":{"comment_hb":true}');
  }

  // Commit origin per transaction.
  {
    const d = loroDoc(docOf(p("origin")));
    const view = mount(d);
    await tick();
    const origins: string[] = [];
    d.subscribe((e) => origins.push(e.origin ?? ""));
    view.dispatch(setCommitOrigin(view.state.tr.insertText("A", 2), "writer:press"));
    view.dispatch(view.state.tr.insertText("B", 2));
    out.commitOrigins = origins;
    view.destroy();
  }

  host.remove();
  return out;
}
