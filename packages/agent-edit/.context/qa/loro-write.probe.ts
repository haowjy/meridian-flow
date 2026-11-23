// Hand-run probe of agent-edit on Loro (design §5) over the in-memory rooms, with a scripted model.
// Run: pnpm --filter @meridian/agent-edit exec tsx .context/qa/loro-write.probe.ts
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import {
  createAgentEditCodecFactory,
  createLoroEditCore,
  createReplyMutations,
  createStaticDocumentLinks,
  type ObservationFrontier,
  renderAgentEditResult,
  type WriteContext,
  type WriteOutcome,
} from "../../src/integration.js";
import { createInMemoryLoroHost } from "../../src/test-support/in-memory-loro-agent-edit.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema }));
let checks = 0;
const fail = (what: string, detail: unknown): never => {
  console.error(`FAIL: ${what}`);
  console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
};
const check = (ok: boolean, what: string, detail?: unknown) => {
  if (!ok) fail(what, detail);
  checks += 1;
};

const paragraph = (id: string, text: string) =>
  schema.nodes.paragraph.create({ id }, text ? schema.text(text) : null);
const texts = (blocks: readonly PMNode[]) => blocks.map((block) => block.textContent);

/** A chat: one thread whose frontiers chain from result to result, as the host records them. */
function chat(threadId: string, turnId: string) {
  const frontiers = new Map<string, ObservationFrontier>();
  const shown: { hash: string; body: string; view: "live" }[] = [];
  const reply = createReplyMutations();
  let planning = new Map<string, ObservationFrontier>();
  const context = (): WriteContext => ({
    threadId,
    turnId,
    responseIdentity: { modelResponseId: `${turnId}-response`, providerResponseId: null },
    frontiers: {
      recording: async (room) => frontiers.get(room) ?? null,
      planning: async (room) => planning.get(room) ?? null,
      planningShown: async () => shown,
      reply,
    },
  });
  return {
    turnId,
    /** A new request: the model plans on what every result so far showed. */
    request() {
      planning = new Map(frontiers);
      reply.clear();
    },
    record(outcome: WriteOutcome) {
      if (outcome.frontier) frontiers.set(outcome.frontier.room, outcome.frontier);
      for (const group of outcome.result.blocks ?? [])
        if (group.extent === "full")
          for (const item of group.items) shown.push({ hash: item.hash, body: item.body, view: "live" });
      return outcome;
    },
    context,
  };
}

const host = createInMemoryLoroHost(schema);
/** A core for a Live chat (`null`) or a Draft chat on `draftId`, as the server's host builds one. */
const coreFor = (draftId: string | null) => {
  const chatRooms = host.chat(draftId);
  return createLoroEditCore({
    rooms: chatRooms.rooms,
    ordinals: host.ordinals,
    schema,
    codec,
    links: createStaticDocumentLinks(undefined, { preloaded: true }),
    documentEdits: chatRooms.documentEdits,
    authorOfTurn: async (turn) => (turn === "t-other" ? "agent (c7)" : null),
  });
};
const core = coreFor(null);
const file = (documentId: string) => ({ file: `${documentId}.md`, documentId });
const text = (outcome: WriteOutcome) => renderAgentEditResult(outcome.result);
const run = <T>(work: () => Promise<T>) => host.command(work);

// 1. A chat reads a chapter, the writer edits a sentence, the chat rewrites another sentence of the
// same paragraph: the writer's sentence stays, and the result names the writer's change.
await host.seed("ch1", [
  paragraph("p1", "The rain fell on the roof. Mara waited by the door."),
  paragraph("p2", "Nobody came that night."),
  paragraph("p3", "In the morning the road was gone."),
]);
const c1 = chat("thread-1", "t1");
c1.request();
const read1 = c1.record(await core.read({ ...file("ch1") } as never, c1.context()));
check(!read1.isError, "read succeeds", text(read1));
const hashes = read1.result.blocks?.[0]?.items.map((item) => item.hash) ?? [];
check(hashes.length === 3, "read shows three blocks", read1.result);

await host.writerEdit("ch1", (blocks) =>
  blocks.map((block) =>
    block.attrs.id === "p1"
      ? paragraph("p1", "The rain hammered the tin roof. Mara waited by the door.")
      : block,
  ),
);

c1.request();
const write1 = c1.record(
  await run(() =>
    core.write(
      {
        command: "replace",
        ...file("ch1"),
        in: hashes[0],
        // The whole paragraph as the model read it, its second sentence rewritten: planned on the
        // read, the first sentence is unchanged and the writer's edit there stands.
        content: "The rain fell on the roof. Mara paced the hall, listening.",
      } as never,
      c1.context(),
    ),
  ),
);
check(!write1.isError, "AI write succeeds", text(write1));
const afterWrite = texts(await host.live("ch1"));
check(
  afterWrite[0] === "The rain hammered the tin roof. Mara paced the hall, listening.",
  "the writer's sentence survives the AI's rewrite of the other",
  afterWrite,
);
const concurrent = write1.result.concurrent?.groups ?? [];
check(
  concurrent.some((group) => group.author === "the user" && [...(group.shown ?? []), ...(group.other ?? [])].includes(hashes[0])),
  "the result names the writer's change",
  { concurrent, text: text(write1) },
);
check(host.records.length === 1 && host.records[0].delta !== null, "the write's record holds its delta", host.records);

// The write landed as an offline peer's edit: its ops carry the turn's commit message.
c1.request();
const write2 = c1.record(
  await run(() =>
    core.write(
      { command: "replace", ...file("ch1"), in: hashes[2], content: "By morning the road had washed away." } as never,
      c1.context(),
    ),
  ),
);
check(!write2.isError, "a second write in the turn succeeds", text(write2));
check(
  !(write2.result.concurrent?.groups ?? []).length,
  "the chat's own earlier write is not listed as someone else's",
  write2.result.concurrent,
);

// 2. Turn Undo takes the AI's words out and leaves the writer's.
await host.writerEdit("ch1", (blocks) =>
  blocks.map((block) =>
    block.attrs.id === "p2" ? paragraph("p2", "Nobody came that night, or the next.") : block,
  ),
);
const undone = await host.undoTurn("ch1", "t1");
check(undone.taken === 2, "turn Undo takes both writes back", undone);
const afterUndo = texts(await host.live("ch1"));
check(
  afterUndo[0] === "The rain hammered the tin roof. Mara waited by the door." &&
    afterUndo[1] === "Nobody came that night, or the next." &&
    afterUndo[2] === "In the morning the road was gone.",
  "turn Undo leaves the writer's words",
  afterUndo,
);

// 3. `format: "edits"` lists the chat's edits.
const edits = await core.read({ ...file("ch1"), format: "edits" } as never, c1.context());
check(!edits.isError && /e1/.test(text(edits)) && /e2/.test(text(edits)), "edits lists e1 and e2", text(edits));

// 4. Another chat's change is named by its chat; a removal by the writer is listed.
const c2 = chat("thread-2", "t-other");
c2.request();
const read2 = c2.record(await core.read({ ...file("ch1") } as never, c2.context()));
const hashes2 = read2.result.blocks?.[0]?.items.map((item) => item.hash) ?? [];
c1.request();
c1.record(await core.read({ ...file("ch1") } as never, c1.context()));
c1.request();
await run(() =>
  core.write(
    { command: "replace", ...file("ch1"), in: hashes2[1], content: "The night stayed empty." } as never,
    c2.context(),
  ),
);
await host.writerEdit("ch1", (blocks) => blocks.filter((block) => block.attrs.id !== "p3"));
const write3 = c1.record(
  await run(() =>
    core.write(
      { command: "insert", ...file("ch1"), after: hashes2[0], content: "Thunder answered." } as never,
      c1.context(),
    ),
  ),
);
const groups3 = write3.result.concurrent?.groups ?? [];
check(
  groups3.some((group) => group.author === "agent (c7)") &&
    groups3.some((group) => group.author === "the user" && group.removed?.includes(hashes2[2])),
  "the listing names the other chat and the writer's removal",
  { groups3, text: text(write3) },
);

// 5. Writes into an emptied document land (the unstored `/empty` paragraph, stored under a fresh
// id by the first op): replaced with one paragraph or three, or inserted after. The result lists
// what was written under its new hash. Then create writes a new document.
const intoEmpty = async (command: Record<string, unknown>, want: string, what: string) => {
  await host.writerEdit("ch1", () => []);
  c1.request();
  const read = c1.record(await core.read({ ...file("ch1") } as never, c1.context()));
  const empty = read.result.blocks?.[0]?.items[0]?.hash;
  c1.request();
  const write = c1.record(
    await run(() => core.write({ ...command, ...file("ch1"), [command.command === "insert" ? "after" : "in"]: empty } as never, c1.context())),
  );
  const live = texts(await host.live("ch1")).join("|");
  check(!write.isError && live === want, what, { live, result: text(write) });
  const listed = (write.result.blocks ?? []).flatMap((group) => group.items.map((item) => item.body));
  check(
    want.split("|").every((line) => listed.some((body) => body.includes(line))),
    `${what}: the result lists every written block`,
    text(write),
  );
};
await intoEmpty({ command: "replace", content: "A new start." }, "A new start.", "one paragraph replaces the empty one");
await intoEmpty(
  { command: "replace", content: "One.\n\nTwo.\n\nThree." },
  "One.|Two.|Three.",
  "three paragraphs replace the empty one",
);
await intoEmpty({ command: "insert", content: "After." }, "After.", "a paragraph goes after the empty one");
const created = await run(() =>
  core.write({ command: "create", ...file("ch2"), content: "# Two\n\nFresh text." } as never, c1.context()),
);
check(!created.isError && texts(await host.live("ch2")).join("|") === "Two|Fresh text.", "create writes a new document", text(created));

// 6. A read below the history cutoff plans on the transcript: a block the model rewrites as read
// keeps the writer's deletion made since, rather than bringing the deleted words back.
await host.seed("ch3", [paragraph("q1", "Alpha one. Alpha two."), paragraph("q2", "Beta.")]);
const c3 = chat("thread-3", "t3");
c3.request();
const read6 = c3.record(await core.read({ ...file("ch3") } as never, c3.context()));
const q1 = read6.result.blocks?.[0]?.items[0]?.hash;
await host.writerEdit("ch3", (blocks) =>
  blocks.map((block) => (block.attrs.id === "q1" ? paragraph("q1", "Alpha two.") : block)),
);
await host.compact("ch3");
c3.request();
const write6 = c3.record(
  await run(() =>
    core.write(
      { command: "replace", ...file("ch3"), in: q1, content: "Alpha one. Alpha TWO." } as never,
      c3.context(),
    ),
  ),
);
const ch3 = texts(await host.live("ch3"));
check(
  !write6.isError && ch3[0] === "Alpha TWO." && ch3[1] === "Beta.",
  "a write planned on the transcript keeps the writer's deletion",
  { ch3, text: text(write6) },
);

// 7. The writer's turn Undo brings back text the chat last saw replaced: an exact find of that text
// lands, though the chat's view still holds its own words there.
await host.seed("ch4", [paragraph("r1", "Base alpha."), paragraph("r2", "Base beta.")]);
const c4 = chat("thread-4", "t4");
c4.request();
c4.record(await core.read({ ...file("ch4") } as never, c4.context()));
c4.request();
const write7 = c4.record(
  await run(() =>
    core.write(
      { command: "replace", ...file("ch4"), find: "Base beta.", content: "AI beta." } as never,
      c4.context(),
    ),
  ),
);
check(!write7.isError, "the chat's first write lands", text(write7));
await host.undoTurn("ch4", "t4");
check(texts(await host.live("ch4"))[1] === "Base beta.", "turn Undo restores the text", await host.live("ch4"));
c4.request();
const write8 = c4.record(
  await run(() =>
    core.write(
      { command: "replace", ...file("ch4"), find: "Base beta.", content: "Draft beta." } as never,
      c4.context(),
    ),
  ),
);
const ch4 = texts(await host.live("ch4"));
check(
  !write8.isError && ch4.join("|") === "Base alpha.|Draft beta.",
  "an exact find of text restored since the chat's read lands",
  { ch4, text: text(write8) },
);

// 8. The writer types in a paragraph after the chat read it, and the chat removes it as it read it.
// The removal did not read the typing, so the room's copy brings the paragraph back (design §1,
// "Removed blocks", rule 1), and the receipt does not call it removed.
await host.seed("ch5", [paragraph("s1", "Keep."), paragraph("s2", "Target")]);
const c5 = chat("thread-5", "t5");
c5.request();
const read8 = c5.record(await core.read({ ...file("ch5") } as never, c5.context()));
const target = read8.result.blocks?.[0]?.items[1]?.hash;
await host.writerEdit("ch5", (blocks) =>
  blocks.map((block) => (block.attrs.id === "s2" ? paragraph("s2", "Target typed") : block)),
);
c5.request();
const write9 = c5.record(
  await run(() => core.write({ command: "remove", ...file("ch5"), in: target } as never, c5.context())),
);
const ch5 = texts(await host.live("ch5"));
const receipt = text(write9);
check(
  !write9.isError && ch5.join("|") === "Keep.|Target typed",
  "a removal that did not read the writer's typing comes back in the room",
  { ch5, text: receipt },
);
check(
  !/removed:/.test(receipt),
  "the receipt does not list the paragraph as removed",
  receipt,
);

// 9. A Draft chat reads a chapter nobody has drafted: its fork room reads as Live. It rewrites two
// paragraphs into the draft; Live is untouched. The writer applies one; the chat's next write to
// that paragraph plans on its fork (no duplicate), and `format: "changes"` shows what still waits.
const draftCore = coreFor("d1");
const draftText = async (doc: string) => texts(await host.draft(doc, "d1"));
await host.seed("ch6", [
  paragraph("u1", "The gate was shut."),
  paragraph("u2", "Rain all night."),
  paragraph("u3", "The dog slept."),
]);
const d9 = chat("thread-9", "t9");
d9.request();
const read9 = d9.record(await draftCore.read({ ...file("ch6") } as never, d9.context()));
check(!read9.isError && read9.frontier?.room === "fork:d1:ch6", "a Draft chat reads its fork room", read9.frontier);
const [u1, u2] = read9.result.blocks?.[0]?.items.map((item) => item.hash) ?? [];
d9.request();
for (const [hash, content] of [
  [u1, "The iron gate was shut."],
  [u2, "Rain fell all night."],
] as const) {
  const written = d9.record(
    await run(() => draftCore.write({ command: "replace", ...file("ch6"), in: hash, content } as never, d9.context())),
  );
  check(!written.isError, "a Draft chat's write lands", text(written));
}
check(
  (await draftText("ch6")).join("|") === "The iron gate was shut.|Rain fell all night.|The dog slept." &&
    texts(await host.live("ch6")).join("|") === "The gate was shut.|Rain all night.|The dog slept.",
  "the writes land in the draft and leave Live",
  { draft: await draftText("ch6"), live: texts(await host.live("ch6")) },
);
check(host.records.at(-1)?.room.kind === "fork", "the write's record names the fork room", host.records.at(-1)?.room);
check(
  (await host.press("apply", "ch6", "d1", ["u1"])) === 1 &&
    texts(await host.live("ch6"))[0] === "The iron gate was shut.",
  "the writer applies one paragraph",
  texts(await host.live("ch6")),
);
d9.request();
const rewrite9 = d9.record(
  await run(() =>
    draftCore.write(
      { command: "replace", ...file("ch6"), in: u1, content: "The iron gate was shut tight." } as never,
      d9.context(),
    ),
  ),
);
check(
  !rewrite9.isError && (await draftText("ch6"))[0] === "The iron gate was shut tight." &&
    texts(await host.live("ch6"))[0] === "The iron gate was shut.",
  "the next write after an Apply plans on the fork: no duplicate, Live keeps the applied text",
  { draft: await draftText("ch6"), live: texts(await host.live("ch6")), text: text(rewrite9) },
);
d9.request();
const changes9 = d9.record(await draftCore.read({ ...file("ch6"), format: "changes" } as never, d9.context()));
const listed9 = text(changes9);
check(
  !changes9.isError &&
    listed9.includes("{~~shut.~>shut tight.~~}") &&
    listed9.includes("Rain {++fell ++}all night.") &&
    !listed9.includes("dog"),
  'format "changes" shows each pending change as CriticMarkup, and nothing else',
  listed9,
);

// 10. `Restore before` the Draft turn returns the fork to the turn's start on today's Live: the
// applied paragraph stays in Live and the draft reads as Live again.
await host.restoreBefore("ch6", "d1", "t9");
const changes10 = await draftCore.read({ ...file("ch6"), format: "changes" } as never, d9.context());
check(
  (await draftText("ch6")).join("|") === texts(await host.live("ch6")).join("|") &&
    texts(await host.live("ch6"))[0] === "The iron gate was shut." &&
    /No changes/.test(text(changes10)),
  "Restore before reverts the fork and leaves the applied paragraph in Live",
  { draft: await draftText("ch6"), live: texts(await host.live("ch6")), changes: text(changes10) },
);
const liveChanges = await core.read({ ...file("ch6"), format: "changes" } as never, d9.context());
check(liveChanges.isError === true || /live, which has none/.test(text(liveChanges)), "a Live chat has no changes to read", text(liveChanges));

// 11. A chat reads in Live, switches to Draft, and writes: the write plans on what it read (the Live
// read, its ops in the fork), so the writer's sentence typed since stays, and the report names
// the writer's Live change, forwarded into the fork, as the user's.
await host.seed("ch7", [paragraph("v1", "Kade ran. The bell rang."), paragraph("v2", "Dusk.")]);
const d11 = chat("thread-11", "t11");
d11.request();
const read11 = d11.record(await core.read({ ...file("ch7") } as never, d11.context()));
const v1 = read11.result.blocks?.[0]?.items[0]?.hash;
await host.writerEdit("ch7", (blocks) =>
  blocks.map((block) => (block.attrs.id === "v1" ? paragraph("v1", "Kade sprinted. The bell rang.") : block)),
);
d11.request();
const write11 = d11.record(
  await run(() =>
    draftCore.write(
      { command: "replace", ...file("ch7"), in: v1, content: "Kade ran. The bell tolled twice." } as never,
      d11.context(),
    ),
  ),
);
check(
  !write11.isError &&
    (await draftText("ch7"))[0] === "Kade sprinted. The bell tolled twice." &&
    texts(await host.live("ch7"))[0] === "Kade sprinted. The bell rang.",
  "a chat switched from Live to Draft plans on its Live read",
  { draft: await draftText("ch7"), live: texts(await host.live("ch7")), text: text(write11) },
);
check(
  (write11.result.concurrent?.groups ?? []).some((group) => group.author === "the user"),
  "the report names the writer's forwarded Live change as the user's",
  text(write11),
);

// 12. The model's own undo in a Draft chat runs on the fork, by content: an edit nobody wrote over
// comes out of the draft (Live untouched); one the writer typed over in the draft stays, and the
// result says so.
await host.seed("ch8", [paragraph("w1", "One."), paragraph("w2", "Two.")]);
const d12 = chat("thread-12", "t12");
d12.request();
const read12 = d12.record(await draftCore.read({ ...file("ch8") } as never, d12.context()));
const [w1, w2] = read12.result.blocks?.[0]?.items.map((item) => item.hash) ?? [];
d12.request();
d12.record(await run(() => draftCore.write({ command: "replace", ...file("ch8"), in: w1, content: "One, said Mara." } as never, d12.context())));
d12.request();
d12.record(await run(() => draftCore.write({ command: "replace", ...file("ch8"), in: w2, content: "Two, said Kade." } as never, d12.context())));
await host.writerEdit(
  "ch8",
  (blocks) => blocks.map((block) => (block.attrs.id === "w1" ? paragraph("w1", "One, Mara whispered.") : block)),
  "d1",
);
d12.request();
const undo12 = await run(() => draftCore.write({ command: "undo", ...file("ch8"), count: 2 } as never, d12.context()));
check(
  !undo12.isError &&
    (await draftText("ch8")).join("|") === "One, Mara whispered.|Two." &&
    texts(await host.live("ch8")).join("|") === "One.|Two." &&
    /e2/.test(text(undo12)) &&
    /e1 stays: someone has written over it/.test(text(undo12)),
  "the model's undo in a draft takes back what stands and leaves the writer's text, saying so",
  { draft: await draftText("ch8"), live: texts(await host.live("ch8")), text: text(undo12) },
);

// 13. After the writer's turn Undo, the same rewrite by hash asked again is not answered
// "unchanged" in silence: the answer shows the text as it stands, and the next write lands.
await host.seed("ch9", [paragraph("x1", "Plain line.")]);
const c13 = chat("thread-13", "t13");
c13.request();
const read13 = c13.record(await core.read({ ...file("ch9") } as never, c13.context()));
const x1 = read13.result.blocks?.[0]?.items[0]?.hash;
const rewrite = () =>
  run(() => core.write({ command: "replace", ...file("ch9"), in: x1, content: "Bright line." } as never, c13.context()));
c13.request();
c13.record(await rewrite());
await host.undoTurn("ch9", "t13");
c13.request();
const again = c13.record(await rewrite());
check(
  /changed since you read it/.test(text(again)) && text(again).includes("Plain line."),
  "a rewrite the view already holds but the room lost shows the text as it stands",
  text(again),
);
c13.request();
const landed13 = c13.record(await rewrite());
check(
  !landed13.isError && texts(await host.live("ch9"))[0] === "Bright line.",
  "the rewrite asked again after seeing the text lands",
  { live: texts(await host.live("ch9")), text: text(landed13) },
);

// 14. A draft the writer emptied: a Draft chat's write into the unstored `/empty` paragraph lands in
// the fork under fresh ids, and the result lists every block it wrote (`renamed` on a fork room).
await host.seed("ch10", [paragraph("y1", "Gone soon.")]);
await host.writerEdit("ch10", () => [], "d1");
const d14 = chat("thread-14", "t14");
d14.request();
const read14 = d14.record(await draftCore.read({ ...file("ch10") } as never, d14.context()));
const empty14 = read14.result.blocks?.[0]?.items[0]?.hash;
d14.request();
const write14 = d14.record(
  await run(() =>
    draftCore.write({ command: "replace", ...file("ch10"), in: empty14, content: "One.\n\nTwo.\n\nThree." } as never, d14.context()),
  ),
);
const listed14 = (write14.result.blocks ?? []).flatMap((group) => group.items.map((item) => item.body));
check(
  !write14.isError &&
    (await draftText("ch10")).join("|") === "One.|Two.|Three." &&
    texts(await host.live("ch10")).join("|") === "Gone soon." &&
    ["One.", "Two.", "Three."].every((line) => listed14.some((body) => body.includes(line))),
  "a Draft chat's write into an emptied draft lands in the fork and lists every block",
  { draft: await draftText("ch10"), live: texts(await host.live("ch10")), text: text(write14) },
);

await host.close();
process.stdout.write(`ok: ${checks} checks\n`);
