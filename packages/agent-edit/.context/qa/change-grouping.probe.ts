import { readdirSync, readFileSync } from "node:fs";
import {
  applyBlocks,
  changedBlocks,
  freshServerPeerId,
  RoomDocs,
  readDocument,
  type ShapeBlock,
  StructureView,
} from "@meridian/document-model";
import { shapeSchemaOf } from "@meridian/loro-prosemirror";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import {
  createAgentEditCodecFactory,
  createStaticDocumentLinks,
  LoroDocument,
  loroModel,
  overwriteWithAssigned,
  toLoroHandle,
} from "../../src/integration.js";

const [chapters, rewrites] = process.argv.slice(2);
const schema = buildDocumentSchema();
const shape = shapeSchemaOf(schema);
const markup = mdxCodec({ schema });
const codec = createAgentEditCodecFactory(markup).forScope(
  createStaticDocumentLinks(undefined, { preloaded: true }),
);
const model = loroModel(schema);

function write(docs: RoomDocs, content: string, message?: string) {
  const written = overwriteWithAssigned({
    doc: toLoroHandle(new LoroDocument(docs, schema, { message })),
    model,
    codec,
    documentId: "d",
    content,
    blocks: markup.parse(content).blocks,
  });
  if (!written.ok) throw new Error(`${written.code}: ${written.message}`);
}

function repeated(docs: RoomDocs): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  const walk = (blocks: readonly ShapeBlock[]) => {
    for (const block of blocks) {
      if (block.kind === "container") walk(block.children);
      else {
        const text = block.inline.map((item) => (item.kind === "text" ? item.text : " ")).join("");
        for (const sentence of text.split(/(?<=[.!?]["”’]?)\s+/)) {
          const key = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
          if (key.split(" ").length < 5) continue;
          if (seen.has(key)) twice.add(key);
          seen.add(key);
        }
      }
    }
  };
  walk(readDocument(docs));
  return twice;
}

function doubling(draft: RoomDocs): number {
  const already = new Set([...repeated(draft), ...repeated(draft.live as RoomDocs)]);
  let count = 0;
  for (const change of changedBlocks(draft)) {
    const copy = draft.fork(freshServerPeerId());
    const live = copy.live as RoomDocs;
    applyBlocks(copy, [change.blocks[0]], { liveVersion: live.version() });
    const fresh = [...repeated(live)].filter((sentence) => !already.has(sentence));
    if (fresh.length > 0) {
      count++;
      if (process.env.DETAIL) {
        const [L, F] = [new StructureView(draft.live as RoomDocs), new StructureView(draft)];
        const text = (docs: RoomDocs, id: string) => docs.textOf(id)?.getText("t").toString().slice(0, 90);
        process.stdout.write(`\nchange ${JSON.stringify(change.blocks)} doubles: ${fresh.map((x) => x.slice(0, 80)).join(" | ")}\n`);
        for (const id of change.blocks)
          process.stdout.write(`  ${id} live:${L.shown.has(id)} fork:${F.shown.has(id)}\n    L ${text(draft.live as RoomDocs, id)}\n    F ${text(draft, id)}\n`);
        const order = F.children(null);
        for (const sentence of fresh)
          for (const id of new Set([...L.shown, ...F.shown])) {
            const hit = (docs: RoomDocs) => (docs.textOf(id)?.getText("t").toString() ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").includes(sentence);
            if (hit(draft.live as RoomDocs) || hit(draft))
              process.stdout.write(`    sentence in ${id} (fork index ${order.indexOf(id)}) live:${hit(draft.live as RoomDocs)} fork:${hit(draft)} changed:${changedBlocks(draft).findIndex((c) => c.blocks.includes(id))}\n`);
          }
      }
    }
    copy.free();
  }
  return count;
}

const rows: Record<string, unknown>[] = [];
for (const file of readdirSync(rewrites).sort()) {
  const [name, ask] = file.split(".");
  const live = RoomDocs.create(shape, freshServerPeerId());
  write(live, readFileSync(`${chapters}/${name}.md`, "utf8"));
  const draft = RoomDocs.draftOf(live, freshServerPeerId());
  write(draft, readFileSync(`${rewrites}/${file}`, "utf8"), "turn:1");
  const changes = changedBlocks(draft);
  const [L, F] = [new StructureView(live), new StructureView(draft)];
  const blocks = changes.flatMap((change) => change.blocks);
  const sizes = changes.map((change) => change.blocks.length).sort((a, b) => b - a);
  rows.push({
    chapter: name,
    ask,
    paragraphs: `${L.shown.size}->${F.shown.size}`,
    rewritten: blocks.filter((id) => L.shown.has(id) && F.shown.has(id)).length,
    added: blocks.filter((id) => !L.shown.has(id)).length,
    removed: blocks.filter((id) => !F.shown.has(id)).length,
    changes: changes.length,
    largest: sizes[0] ?? 0,
    "of 2+": sizes.filter((n) => n > 1).length,
    pieces: new Set(F.overrideKeys("pieces" as never).map((key) => key.split("/", 2).join("/"))).size,
    "doubles alone": doubling(draft),
  });
}
console.table(rows);
process.stdout.write(`${JSON.stringify(rows)}\n`);
