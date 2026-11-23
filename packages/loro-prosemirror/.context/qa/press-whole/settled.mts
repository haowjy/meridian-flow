import * as H from "./probe.mts";

const { setup, edit, posOf, cmd, cmds, show, dm, StructureView } = H;
const check = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const sync = (from, to) => {
  if (from.live && to.live) to.live.importBatch(from.live.exportSince(to.live.version()));
  to.importBatch(from.exportSince(to.version()));
};

const s = setup(["alpha beta gamma", "delta"]);
const draft = s.draft;
edit(draft, (state) => cmd(cmds.splitBlock, posOf(state.doc, "P0", 6))(state));
draft.forward();

const press = draft.fork("41");
const applied = dm.applyBlocks(press, ["P0"], { liveVersion: s.live.version() });
const settled = press.structure.getMap("d.settled").toJSON();
console.log("after apply", show(press.live), show(press), JSON.stringify(settled), JSON.stringify(applied.pressed));
check(
  show(press).match(/^P0:alpha  \| [^:]+:beta gamma \| P1:delta$/),
  "settled Apply should read the Live value once",
);
check(Object.keys(settled).length > 0, "Apply should write a settled record");
check(new StructureView(press).overrideKeys("order").length === 0, "settled order should be absent to readers");

const undone = dm.undoPress(press, applied.pressed);
console.log("after undo", show(press.live), show(press), JSON.stringify(press.structure.getMap("d.settled").toJSON()));
check(show(press.live) === "P0:alpha beta gamma | P1:delta", "press Undo should restore Live");
check(
  show(press).match(/^P0:alpha  \| [^:]+:beta gamma \| P1:delta$/),
  "press Undo should reveal the fork edit",
);
check(Object.keys(press.structure.getMap("d.settled").toJSON()).length === 0, "Undo should delete settle records");
check(undone.stayed.length === 0, "quiet press Undo should not stay");

const discardedRoom = setup(["alpha beta gamma", "delta"]);
const discardedDraft = discardedRoom.draft;
edit(discardedDraft, (state) => cmd(cmds.splitBlock, posOf(state.doc, "P0", 6))(state));
discardedDraft.forward();
const discardCopy = discardedDraft.fork("61");
const discarded = dm.discardBlocks(discardCopy, ["P0"]);
check(show(discardCopy) === show(discardCopy.live), "Discard should settle to Live without a null order");
check(Object.keys(discardCopy.structure.getMap("d.settled").toJSON()).length > 0, "Discard should settle records");
dm.undoPress(discardCopy, discarded.pressed);
check(show(discardCopy) === "P0:alpha  | " + show(discardedDraft).split(" | ")[1] + " | P1:delta", "Discard Undo should reveal the fork edit");

const equalRoom = setup(["alpha beta gamma", "delta"]);
const equalDraft = equalRoom.draft;
edit(equalDraft, (state) => cmd(cmds.splitBlock, posOf(state.doc, "P0", 6))(state));
equalDraft.forward();
const equalPress = equalDraft.fork("71");
dm.applyBlocks(equalPress, ["P0"], { liveVersion: equalRoom.live.version() });
const equalView = new StructureView(equalPress);
const equalId = Object.keys(equalPress.structure.getMap("d.settled").toJSON())
  .map((key) => key.split("/").slice(1).join("/"))
  .find((key) => equalView.rawOverride("order", key) !== undefined) as string;
const equalValue = equalView.rawOverride("order", equalId);
const equalBefore = equalPress.structure.frontiers();
new dm.StructureWriter(equalPress, equalView).set("order", equalId, equalValue);
dm.commitStructure(equalPress, equalBefore, {});
check(
  equalPress.structure.getMap("d.settled").get(dm.settledKey("order", equalId)) === undefined,
  "equal writer should clear its settle record",
);
check(
  new StructureView(equalPress).override("order", equalId) === undefined,
  "equal writer should leave a matching value absent as an override",
);

