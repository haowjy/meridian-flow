// Runnable throwaway harness that drives the real @meridian/agent-edit write() path.

import {
  type AgentEditCore,
  createAgentEditCodec,
  createAgentEditCore,
  type WriteContext,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";

import { InMemoryCoordinator, InMemoryJournal } from "./fakes.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodec(mdxCodec({ schema }));
const model = yProsemirrorModel(schema);
const defaultContext: WriteContext = { sessionId: "demo-session", threadId: "demo-thread" };

interface DemoEnvironment {
  core: AgentEditCore;
  journal: InMemoryJournal;
  coordinator: InMemoryCoordinator;
}

interface BlockLine {
  index: number;
  hash: string;
  text: string;
}

async function main() {
  const env = createEnvironment();
  const docId = "chapter-1.mdx";

  await scenarioCreate(env, docId);
  await scenarioView(env, docId);
  await scenarioInsert(env, docId);
  await scenarioReplace(env, docId);
  await scenarioDelete(env, docId);
  await scenarioCrossBlockFind(env, docId);
  await scenarioMultiWriteTurn();
  await scenarioConcurrentReconciled();
  await scenarioColdUndoAfterRestart();

  section("All assertions passed");
}

function createEnvironment(journal = new InMemoryJournal(), coordinator?: InMemoryCoordinator) {
  const fakeServer = coordinator ?? new InMemoryCoordinator(journal);
  return {
    journal,
    coordinator: fakeServer,
    core: createAgentEditCore({
      journal,
      coordinator: fakeServer,
      lifecycle: fakeServer,
      codec,
      model,
      defaultSessionId: "demo-session",
      defaultThreadId: "demo-thread",
    }),
  } satisfies DemoEnvironment;
}

async function scenarioCreate(env: DemoEnvironment, docId: string) {
  section("1. create: seed a markdown/MDX document");
  const result = await env.core.write(
    {
      command: "create",
      file: docId,
      content:
        "# Chapter 1: The Wake\n\nThe sword hummed beneath the old shrine.\n\nMoonlight pooled across the floor.",
    },
    defaultContext,
  );
  print("write(create) result", result.text);
  printBlocks("live doc", await blocks(env, docId));
  assert(result.text.includes("status: success"), "create should succeed");
  assert((await blocks(env, docId)).length === 3, "create should produce three blocks");
}

async function scenarioView(env: DemoEnvironment, docId: string) {
  section("2. read: full and outline with block hashes");
  const full = await env.core.write(
    { command: "read", file: docId, format: "full" },
    defaultContext,
  );
  print("write(read, full)", full.text);
  const outline = await env.core.write(
    { command: "read", file: docId, format: "outline" },
    defaultContext,
  );
  print("write(read, outline)", outline.text);
  printBlocks("hash index", await blocks(env, docId));
  assert(/^([0-9a-f]{4,})\|# Chapter/m.test(full.text), "full read should include block hashes");
  assert(
    outline.text.includes('write(command="read"'),
    "outline should include drill-down command",
  );
}

async function scenarioInsert(env: DemoEnvironment, docId: string) {
  section("3. insert: after a target block hash");
  const firstParagraph = (await blocks(env, docId))[1];
  assert(firstParagraph !== undefined, "first paragraph should exist before insert");
  const result = await env.core.write(
    {
      command: "insert",
      file: docId,
      after: firstParagraph.hash,
      content: "A foxfire lantern flared to life.",
    },
    defaultContext,
  );
  print(`write(insert after ${firstParagraph.hash})`, result.text);
  printBlocks("live doc", await blocks(env, docId));
  assert(
    (await plainTexts(env, docId)).includes("A foxfire lantern flared to life."),
    "inserted paragraph should be present",
  );
}

async function scenarioReplace(env: DemoEnvironment, docId: string) {
  section("4. replace: find a phrase and replace it");
  const result = await env.core.write(
    { command: "replace", file: docId, find: "sword", content: "blade" },
    defaultContext,
  );
  print('write(replace find "sword" -> "blade")', result.text);
  printBlocks("live doc", await blocks(env, docId));
  assert((await rendered(env, docId)).includes("The blade hummed"), "find replace should apply");
}

async function scenarioDelete(env: DemoEnvironment, docId: string) {
  section("5. delete: replace a block with empty content");
  const before = await blocks(env, docId);
  const inserted = before.find((block) => block.text === "A foxfire lantern flared to life.");
  assert(inserted !== undefined, "inserted paragraph should exist before delete");
  const result = await env.core.write(
    { command: "replace", file: docId, in: inserted.hash, content: "" },
    defaultContext,
  );
  const after = await blocks(env, docId);
  print(`write(replace in ${inserted.hash}, content="")`, result.text);
  print(`block count: ${before.length} -> ${after.length}`, "");
  printBlocks("live doc", after);
  assert(result.text.includes("deleted:"), "delete should report the deleted hash");
  assert(after.length === before.length - 1, "block count should drop by one");
}

async function scenarioCrossBlockFind(env: DemoEnvironment, docId: string) {
  section("6. cross-block find: replace text spanning two blocks");
  const result = await env.core.write(
    {
      command: "replace",
      file: docId,
      find: "old shrine.\n\nMoonlight pooled",
      content: "old shrine as moonlight pooled",
    },
    defaultContext,
  );
  print("write(replace cross-block find)", result.text);
  printBlocks("live doc", await blocks(env, docId));
  const text = await rendered(env, docId);
  assert(result.text.includes("status: success"), "cross-block replace should succeed");
  assert(
    text.includes("old shrine as moonlight pooled"),
    "cross-block replacement should merge text",
  );
}

async function scenarioMultiWriteTurn() {
  section("7. multi-write turn: one turnId groups two write() calls for undo/redo");
  const env = createEnvironment();
  const docId = "turn-demo.mdx";
  await env.core.write(
    { command: "create", file: docId, content: "Alpha sword.\n\nOmega." },
    defaultContext,
  );
  await env.core.write({ command: "read", file: docId }, defaultContext);

  const alpha = (await blocks(env, docId))[0];
  assert(alpha !== undefined, "turn demo alpha block should exist");
  const turnContext = { ...defaultContext, turnId: "demo-turn-two-writes" };
  const insert = await env.core.write(
    { command: "insert", file: docId, after: alpha.hash, content: "Inserted in the same turn." },
    turnContext,
  );
  const replace = await env.core.write(
    { command: "replace", file: docId, find: "sword", content: "blade" },
    turnContext,
  );
  print("write(insert, turnId=demo-turn-two-writes)", insert.text);
  print("write(replace, same turnId)", replace.text);
  printBlocks("after two writes", await blocks(env, docId));

  const undo = await env.core.write({ command: "undo", file: docId }, defaultContext);
  print("write(undo)", undo.text);
  printBlocks("after undo", await blocks(env, docId));
  assert(undo.text.includes("undo: 1 edit(s)"), "undo should report the grouped edit count");
  assert(
    equal(await plainTexts(env, docId), ["Alpha sword.", "Omega."]),
    "undo should reverse both writes in the turn",
  );

  const redo = await env.core.write({ command: "redo", file: docId }, defaultContext);
  print("write(redo)", redo.text);
  printBlocks("after redo", await blocks(env, docId));
  assert(
    equal(await plainTexts(env, docId), ["Alpha blade.", "Inserted in the same turn.", "Omega."]),
    "redo should restore both writes in the turn",
  );
}

async function scenarioConcurrentReconciled() {
  section("8. concurrent/reconciled: human edits live doc after agent sync");
  const env = createEnvironment();
  const docId = "concurrent-demo.mdx";
  await env.core.write(
    { command: "create", file: docId, content: "Alpha waits.\n\nBeta carries a sword." },
    defaultContext,
  );
  await env.core.write({ command: "read", file: docId }, defaultContext);

  const humanSeq = await env.coordinator.applyHumanUpdate(docId, "human-demo", (doc) => {
    const first = model.getBlocks(doc)[0];
    assert(first !== undefined, "first block should exist for human edit");
    model.applyTextEdit(doc, first, { from: 0, to: 0 }, "Human note: ");
  });
  print(`human direct live edit persisted at seq ${humanSeq}`, await rendered(env, docId));

  const result = await env.core.write(
    { command: "replace", file: docId, find: "sword", content: "blade" },
    defaultContext,
  );
  print('write(replace stale snapshot find "sword" -> "blade")', result.text);
  printBlocks("merged live doc", await blocks(env, docId));
  assert(
    result.text.includes("status: success"),
    "agent replace should still succeed after human edit",
  );
  assert(
    result.text.includes("concurrent edits:"),
    "result should report the concurrent human edit",
  );
  assert(
    (await rendered(env, docId)).includes("Human note: Alpha waits."),
    "human edit should survive merge",
  );
}

async function scenarioColdUndoAfterRestart() {
  section("9. cold undo after restart: fresh core reconstructs from the journal");
  const env = createEnvironment();
  const docId = "cold-restart.mdx";
  const initial = "Alpha sword.\n\nOmega waits.";

  await env.core.write({ command: "create", file: docId, content: initial }, defaultContext);
  await env.core.write({ command: "read", file: docId }, defaultContext);
  await env.core.write(
    { command: "replace", file: docId, find: "sword", content: "blade" },
    { ...defaultContext, turnId: "demo-thread:cold-restart-edit" },
  );

  const freshCoreEnv = createEnvironment(env.journal, env.coordinator);
  await freshCoreEnv.core.write({ command: "read", file: docId }, defaultContext);
  const undo = await freshCoreEnv.core.write({ command: "undo", file: docId }, defaultContext);
  const afterUndo = await rendered(env, docId);
  print("cold reconstruction undo", undo.text);
  print("rendered after undo", afterUndo);

  assert(undo.text.includes("status: reversed"), "cold undo should reverse the edit");
  assert(afterUndo.includes("Alpha sword."), "cold undo should restore the original text");
}

async function blocks(env: DemoEnvironment, docId: string): Promise<BlockLine[]> {
  return env.coordinator.withDocument(docId, async (doc) =>
    model.getBlocks(doc).map((block, index) => ({
      index,
      hash: model.getBlockId(block),
      text: model.getText(block),
    })),
  );
}

async function plainTexts(env: DemoEnvironment, docId: string): Promise<string[]> {
  return (await blocks(env, docId)).map((block) => block.text);
}

async function rendered(env: DemoEnvironment, docId: string): Promise<string> {
  return env.coordinator.withDocument(docId, async (doc) => serializeWithoutHashes(doc));
}

function serializeWithoutHashes(doc: Y.Doc): string {
  return codec.serialize(model.getBlocks(doc).map((block) => model.toProsemirrorBlock(doc, block)));
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function print(label: string, body: string) {
  console.log(`\n-- ${label} --`);
  if (body.length > 0) console.log(body);
}

function printBlocks(label: string, lines: BlockLine[]) {
  print(label, lines.map((block) => `${block.index}. ${block.hash} | ${block.text}`).join("\n"));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function equal(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

main().catch((cause) => {
  console.error(cause);
  process.exitCode = 1;
});
