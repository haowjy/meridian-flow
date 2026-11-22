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
const core = createLoroEditCore({
  rooms: host.agentRooms,
  journal: host.journal,
  schema,
  codec,
  links: createStaticDocumentLinks(undefined, { preloaded: true }),
  documentEdits: host.documentEdits,
  authorOfTurn: async (turn) => (turn === "t-other" ? "agent (c7)" : null),
});
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

// 5. A write into an emptied document lands (`/empty`), and so does create into a new one.
await host.writerEdit("ch1", () => []);
c1.request();
const read4 = c1.record(await core.read({ ...file("ch1") } as never, c1.context()));
const empty = read4.result.blocks?.[0]?.items[0]?.hash;
c1.request();
const write4 = c1.record(
  await run(() =>
    core.write({ command: "replace", ...file("ch1"), in: empty, content: "A new start." } as never, c1.context()),
  ),
);
check(!write4.isError && texts(await host.live("ch1"))[0] === "A new start.", "a write into an emptied document lands", text(write4));
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

await host.close();
process.stdout.write(`ok: ${checks} checks\n`);
