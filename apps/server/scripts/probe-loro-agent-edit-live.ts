import {
  createAgentEditCodecFactory,
  createLoroEditCore,
  createReplyMutations,
  createStaticDocumentLinks,
  type ObservationFrontier,
  ReadCommandSchema,
  renderAgentEditResult,
  WriteCommandSchema,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import { createInMemoryLoroHost } from "@meridian/agent-edit/test-support";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Message, Tool } from "@meridian-flow/runtime/gateway";
import { z } from "zod";
import { createGatewayFromEnv } from "../server/lib/gateway/create-from-env.js";

const model = process.env.LIVE_TEST_MODEL;
if (!model) throw new Error("Set LIVE_TEST_MODEL (deepseek-flash)");
const { gateway, cleanup } = await createGatewayFromEnv(process.env);
const schema = buildDocumentSchema();
const host = createInMemoryLoroHost(schema);
/** The chat's core: Live (`null`), or Draft on the draft's fork room once the writer switches it. */
const coreFor = (draftId: string | null) => {
  const chat = host.chat(draftId);
  return createLoroEditCore({
    rooms: chat.rooms,
    ordinals: host.ordinals,
    schema,
    codec: createAgentEditCodecFactory(mdxCodec({ schema })),
    links: createStaticDocumentLinks(undefined, { preloaded: true }),
    documentEdits: chat.documentEdits,
  });
};
let core = coreFor(null);
const paragraph = (id: string, text: string) =>
  schema.nodes.paragraph.create({ id }, schema.text(text));
const texts = async () => (await host.live("ch1")).map((block) => block.textContent);

const toolSchema = (zod: z.ZodType) => {
  const json = z.toJSONSchema(zod, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
};
const tools: Tool[] = [
  {
    type: "function",
    name: "read",
    description: "Read a document of the project. `file` is its path, e.g. ch1.md.",
    inputSchema: toolSchema(ReadCommandSchema),
  },
  {
    type: "function",
    name: "write",
    description: "Change a document: a replace, insert or remove addressed by block hash.",
    inputSchema: toolSchema(WriteCommandSchema),
  },
];

const frontiers = new Map<string, ObservationFrontier>();
const messages: Message[] = [
  {
    role: "system",
    content: [
      {
        type: "text",
        text: "You edit a novel's chapters with the read and write tools. Read before you write. Change only what you are asked to.",
      },
    ],
  },
];
const log: string[] = [];

/** One model turn: the user's message, then tool calls until the model answers in text. */
async function turn(turnId: string, ask: string): Promise<WriteOutcome[]> {
  messages.push({ role: "user", content: [{ type: "text", text: ask }] });
  const planning = new Map(frontiers);
  const reply = createReplyMutations();
  const outcomes: WriteOutcome[] = [];
  for (let step = 0; step < 6; step++) {
    const result = await (async () => {
      for await (const event of gateway.stream({
        model,
        messages,
        tools,
        promptCacheRetention: "none",
      })) {
        if (event.type === "end") return event.result;
        if (event.type === "error") throw new Error(`${event.code}: ${event.message}`);
      }
      throw new Error("stream ended without a result");
    })();
    const toolUses = result.content.filter((part) => part.type === "tool_use");
    messages.push({
      role: "assistant",
      content: result.content.filter(
        (part) => part.type === "text" || part.type === "tool_use" || part.type === "reasoning",
      ) as never,
    });
    if (toolUses.length === 0) break;
    const results = [];
    for (const use of toolUses) {
      if (use.type !== "tool_use") continue;
      const input = { ...use.input, documentId: "ch1" } as never;
      const context = {
        threadId: "thread-live",
        turnId,
        tool_use_id: use.toolCallId,
        responseIdentity: { modelResponseId: `${turnId}-${step}`, providerResponseId: null },
        frontiers: {
          recording: async (documentId: string) => frontiers.get(documentId) ?? null,
          planning: async (documentId: string) => planning.get(documentId) ?? null,
          reply,
        },
      };
      const outcome =
        use.toolName === "read"
          ? await core.read(input, context)
          : await host.command(() => core.write(input, context));
      // The chat's latest read of the document, in whichever room: the port answers by document.
      if (outcome.frontier) frontiers.set("ch1", outcome.frontier);
      outcomes.push(outcome);
      const rendered = renderAgentEditResult(outcome.result);
      log.push(`--- ${turnId} ${use.toolName} ${JSON.stringify(use.input)}\n${rendered}`);
      results.push({
        type: "tool_result" as const,
        toolCallId: use.toolCallId,
        content: [{ type: "text" as const, text: rendered }],
        ...(outcome.isError ? { isError: true } : {}),
      });
    }
    messages.push({ role: "tool", content: results });
  }
  return outcomes;
}

const fail = (what: string): never => {
  console.error(log.join("\n"));
  console.error(`FAIL: ${what}`);
  process.exit(1);
};

await host.seed("ch1", [
  paragraph("p1", "The rain fell on the roof. Mara waited by the door."),
  paragraph("p2", "Nobody came that night."),
  paragraph("p3", "In the morning the road was gone."),
]);

const t1 = await turn("t1", "Read ch1.md.");
if (!t1.some((outcome) => outcome.command === "read" && !outcome.isError)) fail("turn 1 read ch1");

await host.writerEdit("ch1", (blocks) =>
  blocks.map((block) =>
    block.attrs.id === "p1"
      ? paragraph("p1", "The rain hammered the tin roof. Mara waited by the door.")
      : block,
  ),
);

const t2 = await turn(
  "t2",
  "In ch1.md, rewrite only the sentence about Mara in the first paragraph so that she paces the hall. Don't read again; write now.",
);
const written = t2.filter((outcome) => outcome.command === "replace" && !outcome.isError);
if (written.length === 0) fail("turn 2 wrote");
const after = await texts();
console.log("after the AI's write:", after);
if (!after[0].includes("hammered the tin roof")) fail("the writer's sentence survives");
if (!/pac/i.test(after[0])) fail("the AI's sentence landed");
const named = written.some((outcome) =>
  (outcome.result.concurrent?.groups ?? []).some((group) => group.author === "the user"),
);
if (!named) fail("the result names the writer's change");

const undone = await host.undoTurn("ch1", "t2");
const afterUndo = await texts();
console.log("after turn Undo:", afterUndo, undone);
if (afterUndo[0] !== "The rain hammered the tin roof. Mara waited by the door.")
  fail("turn Undo takes the AI's words out and leaves the writer's");

const t3 = await turn("t3", 'List your edits to ch1.md: read it with format "edits".');
const edits = t3.find((outcome) => outcome.command === "read" && !outcome.isError);
if (!edits || !/e1/.test(renderAgentEditResult(edits.result))) fail("format edits lists e1");

// The writer switches the chat to Draft mode: its writes go to draft d1's fork of ch1.
core = coreFor("d1");
const t4 = await turn(
  "t4",
  "You are in draft mode now. In ch1.md, change the second paragraph so that nobody came for three nights.",
);
if (!t4.some((outcome) => outcome.command === "replace" && !outcome.isError)) fail("turn 4 wrote");
const draft = (await host.draft("ch1", "d1")).map((block) => block.textContent);
console.log("draft after turn 4:", draft);
if (!/three nights/i.test(draft[1] ?? "")) fail("the Draft write lands in the draft");
if ((await texts())[1] !== "Nobody came that night.") fail("the Draft write leaves Live");
const t5 = await turn(
  "t5",
  'Show what your draft changes in ch1.md: read it with format "changes".',
);
const changes = t5.find((outcome) => outcome.command === "read" && !outcome.isError);
if (!changes || !/\{(\+\+|~~)/.test(renderAgentEditResult(changes.result)))
  fail("format changes shows the draft's change as CriticMarkup");

console.log(log.join("\n"));
console.log("ok: live scenarios pass on", model);
await host.close();
await cleanup?.();
