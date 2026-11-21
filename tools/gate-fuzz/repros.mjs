// Minimal repros of the failure classes the fuzz found: `node --import tsx repros.mjs` (GATE_BINDING as for fuzz.mjs)
import { LoroDoc } from "loro-crdt";
import * as M from "./block-diff.mjs";
import {
  checkReal,
  commentMark,
  copyOf,
  edit,
  forkOf,
  freeAll,
  newDoc,
  read,
  schema,
  withIds,
  writeDoc,
} from "./codec.mjs";

const p = (t, attrs = {}) => schema.nodes.paragraph.create(attrs, t ? schema.text(t) : null);
const live0 = (...texts) => {
  const live = newDoc("1");
  writeDoc(
    live,
    withIds(
      schema.nodes.doc.create(
        null,
        texts.map((t) => p(t)),
      ),
    ),
    "init",
  );
  live.commit();
  return live;
};
const text = (doc) =>
  read(doc)
    .content.content.map((b) => b.textContent)
    .join(" | ");
const marked = (doc) =>
  read(doc)
    .content.content.map((b) =>
      b.content.content.map((n) => (n.marks.length ? `[${n.text}]` : (n.text ?? "¶"))).join(""),
    )
    .join(" | ");
const at = (doc, i) => {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return pos;
};
const ids = (doc) => read(doc).content.content.map((b) => b.attrs.id);
const out = (name, ok, detail) => console.log(`${ok ? "ok  " : "FAIL"} ${name}\n     ${detail}`);

// R1 (Loro): whether a concurrent insert at a mark's end gets the mark is decided by peer order, even for expand none.
{
  const res = [];
  for (const [pa, pb] of [
    ["1", "100"],
    ["100", "1"],
  ]) {
    const a = new LoroDoc();
    a.configDefaultTextStyle({ expand: "none" });
    a.setPeerId(pa);
    a.getText("t").insert(0, "abcdef");
    a.commit();
    const b = a.fork();
    b.setPeerId(pb);
    a.getText("t").mark({ start: 1, end: 3 }, "comment_c1", true);
    a.commit();
    b.getText("t").insert(3, "XY");
    b.commit();
    a.import(b.export({ mode: "update", from: a.oplogVersion() }));
    res.push(
      a
        .getText("t")
        .toDelta()
        .map((s) => (s.attributes ? `[${s.insert}]` : s.insert))
        .join(""),
    );
  }
  out(
    "R1 Loro: a comment (expand none) on 'bc' and a concurrent 'XY' typed after it",
    res[0] === res[1],
    `marker peer 1: ${res[0]}   marker peer 100: ${res[1]}`,
  );
}

// R2 (model + R1): Apply leaves the fork's own mark, which takes in Live's copy of the next run.
{
  const live = live0("abcdef");
  const fork = forkOf(live, "100");
  edit(fork, (tr) => tr.insertText("XY", 4));
  edit(fork, (tr) => tr.addMark(2, 4, commentMark("c1")));
  M.applyBlocks(live, fork, "all", "press");
  out(
    "R2 Apply of 'XY' typed after 'c', then a comment on 'bc'",
    marked(live) === marked(fork),
    `live ${marked(live)}   fork ${marked(fork)}`,
  );
}

// R3 (model): a partial Apply of a new block whose neighbour is another new block reorders the draft.
{
  const live = live0("Q", "H");
  const fork = forkOf(live, "100");
  edit(fork, (tr, d) =>
    tr.insert(at(d, 1), withIds(schema.nodes.doc.create(null, [p("V"), p("F")])).content),
  );
  const before = text(fork);
  const fId = ids(fork)[2];
  M.applyBlocks(live, fork, [fId], "press");
  out(
    "R3 the draft adds V then F between Q and H; Apply F alone",
    text(fork) === before,
    `fork before ${before}   after ${text(fork)}   live ${text(live)}`,
  );
}

// R4 (model): a Reset that gives back a deleted block makes a copy; Live's later typing in the block never reaches it.
for (const mode of ["no reshare", "reshare, Live tab synced", "reshare racing a Live tab"]) {
  const live = live0("A", "B", "C");
  const tab = copyOf(live, "2");
  const fork = forkOf(live, "100");
  const bId = ids(fork)[1];
  edit(fork, (tr, d) => tr.delete(at(d, 1), at(d, 2)));
  M.resetBlocks(live, fork, [bId], "reset");
  if (mode !== "no reshare") M.reshare(live, fork);
  if (mode === "reshare, Live tab synced")
    tab.import(live.export({ mode: "update", from: tab.oplogVersion() }));
  edit(tab, (tr, d) => tr.insertText(" typed", at(d, 1) + 2));
  live.import(tab.export({ mode: "update", from: live.oplogVersion() }));
  const pending = M.changedBlocks(live, fork).changes.length;
  M.applyBlocks(live, fork, "all", "press");
  out(
    `R4 Reset of a deleted block, then Live types in it (${mode})`,
    pending === 0 && text(live).includes("typed"),
    `pending after Live typed: ${pending}; after Apply-all Live: ${text(live)}`,
  );
}

// R5 (design §5): Restore before as written reverts Live edits forwarded into the fork since the turn.
for (const fn of ["restoreBeforeAsWritten", "restoreBeforeOnLive"]) {
  const live = live0("alpha", "beta");
  const fork = forkOf(live, "100");
  const before = fork.frontiers();
  edit(fork, (tr) => tr.insertText("TURN ", 1), { message: "turn:t1" });
  const tab = copyOf(live, "2");
  edit(tab, (tr, d) => tr.insertText("LIVE ", at(d, 1) + 1));
  live.import(tab.export({ mode: "update", from: live.oplogVersion() }));
  M.forward(live, fork);
  if (fn === "restoreBeforeAsWritten") M.restoreBeforeAsWritten(fork, before, "restore");
  else M.restoreBeforeOnLive(live, fork, before, "restore");
  const pending = M.changedBlocks(live, fork).changes.length;
  out(
    `R5 ${fn}: a turn typed 'TURN', then Live typed 'LIVE' in another block`,
    pending === 0,
    `fork ${text(fork)}   live ${text(live)}   pending ${pending}`,
  );
}

// R6 (binding): upstream pairs child maps by position and node name, so a block's container can take another block's id.
{
  const live = live0("A", "B", "C", "D");
  const fork = forkOf(live, "100");
  const cid = (doc) =>
    new Map(
      doc
        .getMap("doc")
        .get("children")
        .toArray()
        .map((c) => [c.get("attributes").get("id"), c.id]),
    );
  edit(fork, (tr, d) =>
    tr.delete(at(d, 1), at(d, 2)).insert(at(d, 3) - (at(d, 2) - at(d, 1)), p("E")),
  );
  const l = cid(live);
  const f = cid(fork);
  const drifted = [...f]
    .filter(([id, c]) => l.has(id) && l.get(id) !== c)
    .map(([id]) => ids(live).indexOf(id));
  out(
    "R6 one transaction deletes B and adds E after C",
    drifted.length === 0,
    `blocks whose fork container differs from Live's (by index in Live): ${JSON.stringify(drifted)} (C was not edited)`,
  );
}

// R7 (binding shape): an inline node typed into a paragraph re-types the text after it; a concurrent delete there is undone.
{
  const live = live0("one two three");
  const a = copyOf(live, "2");
  const b = copyOf(live, "3");
  edit(a, (tr) => tr.insert(4, schema.nodes.hard_break.create()));
  edit(b, (tr) => tr.delete(8, 14));
  a.import(b.export({ mode: "update", from: a.oplogVersion() }));
  b.import(a.export({ mode: "update", from: b.oplogVersion() }));
  out(
    "R7 tab 1 puts a hard break after 'one'; tab 2 deletes ' three' meanwhile",
    !text(a).includes("three"),
    `merged: ${JSON.stringify(text(a))}`,
  );
}

// R8 (approach A): the stale tab's update carries the discarded draft into whatever fork takes it.
{
  const live = live0("alpha", "beta");
  const gen1 = forkOf(live, "100");
  edit(gen1, (tr) => tr.insertText("DRAFT ", 1));
  const stale = copyOf(gen1, "4");
  edit(stale, (tr, d) => tr.insertText(" typed", at(d, 1) + 5));
  // Discard (A): gen1 unlinked. The draft writes again: generation 2, forked from Live.
  const gen2 = forkOf(live, "200");
  edit(gen2, (tr, d) => tr.insertText("NEW ", at(d, 1) + 1));
  gen2.import(stale.export({ mode: "update", from: gen2.oplogVersion() }));
  out(
    "R8 A: stale tab reconnects into the draft's new generation",
    !text(gen2).includes("DRAFT"),
    `gen2: ${text(gen2)}`,
  );
}

// R9 (approach B): the stale tab's update merges into the one fork; the Discard's deletes win.
{
  const live = live0("alpha", "beta");
  const fork = forkOf(live, "100");
  edit(fork, (tr) => tr.insertText("DRAFT ", 1));
  const stale = copyOf(fork, "4");
  edit(stale, (tr, d) => tr.insertText(" typed", at(d, 1) + 5));
  M.resetBlocks(live, fork, "all", "discard");
  fork.import(stale.export({ mode: "update", from: fork.oplogVersion() }));
  out(
    "R9 B: stale tab reconnects into the same fork after a Discard",
    !text(fork).includes("DRAFT") && text(fork).includes("typed"),
    `fork: ${text(fork)}   pending: ${M.changedBlocks(live, fork).changes.length}`,
  );
}
// R10 (Loro + binding): Loro keeps every concurrent mark; the schema's `excludes` (code excludes all marks) is not a merge rule.
{
  const live = live0("one two");
  const a = copyOf(live, "2");
  const b = copyOf(live, "3");
  edit(a, (tr) => tr.addMark(1, 4, schema.marks.code.create()));
  edit(b, (tr) => tr.addMark(1, 4, schema.marks.em.create()));
  a.import(b.export({ mode: "update", from: a.oplogVersion() }));
  let res;
  try {
    checkReal(a);
    res = "valid";
  } catch (e) {
    res = e.message;
  }
  out("R10 tab 1 makes 'one' code; tab 2 makes it italic meanwhile", res === "valid", `merged: ${res}`);
}
freeAll();
