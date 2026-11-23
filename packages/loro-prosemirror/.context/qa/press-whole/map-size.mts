import * as H from "./probe.mts";

const shape = H.lp.shapeSchemaOf(H.schema);
const live = H.RoomDocs.create(shape, "1");
const blocks = Array.from({ length: 500 }, (_, i) =>
  H.schema.nodes.paragraph.create({ id: `P${i}` }, H.schema.text(`paragraph ${i}`)),
);
H.lp.writeProseMirror(live, H.schema.nodes.doc.create(null, blocks), { message: "init" });
const draft = H.RoomDocs.draftOf(live, "2");
const view = new H.StructureView(draft);
const before = draft.structure.frontiers();
const writer = new H.dm.StructureWriter(draft, view);
for (let i = 0; i < 500; i++) writer.set("attrs", `P${i}/level`, 1);
H.dm.commitStructure(draft, before, {});
const press = draft.fork("3");
H.dm.applyBlocks(press, "all", { liveVersion: live.version() });
const settled = press.structure.getMap("d.settled").toJSON();
console.log(
  JSON.stringify({
    blocks: 500,
    settledKeys: Object.keys(settled).length,
    settledJsonBytes: Buffer.byteLength(JSON.stringify(settled)),
    structureUpdateBytes: press.structure.export({ mode: "update" }).byteLength,
  }),
);
