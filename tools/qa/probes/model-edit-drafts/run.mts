/**
 * The crash test of the model's edits to a draft, through the real chat loop: a chat in draft
 * mode writes to its Work's draft, the parent kills or holds the process at a named step,
 * and a second process recovers. Asserts on stored rows only: the live document, the Work's
 * draft, the result blocks, the edit receipts and the command rows.
 *
 *   pnpm exec tsx tools/qa/probes/model-edit-drafts/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a draft-mode write creates its Work draft inside the command's transaction
 * - a write whose last seen draft was discarded is refused, and the refusal is the stored outcome
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendToFirstParagraph } from "../drafts-lock-free/harness.mts";
import {
  type Child,
  draftDoc,
  drafts,
  insertCall,
  type ModelEditCase,
  runCases,
  seedCase,
  seedWorkWithChats,
  send,
  state,
  waitForAssistantTurn,
} from "../model-edit-harness/harness.mts";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const reply = { text: "done" };
const SEED = ["Live seed."];
const oneCall = (path: string) => [{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply];

type Harness = Parameters<typeof state>[0];

async function recover(start: () => Promise<Child>, h: Harness, thread: string) {
  const second = await start();
  await second.call({ op: "sweep" });
  await waitForAssistantTurn(h, thread);
}

/** A draft-mode write killed at `point`, then recovered. */
function killedAt(
  name: string,
  point: string,
  expected: string,
  after: { results: string[]; edits: string[]; commands: string[]; draft: string[] | null },
): ModelEditCase {
  return {
    name,
    expected,
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, name, "draft");
      const first = await start();
      await first.arm(point, "kill");
      await first.script(oneCall(path));
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      await recover(start, h, thread);
      const { draft, ...rest } = after;
      assert.deepEqual(await state(h, thread, documentId), {
        doc: SEED,
        turns: ["error"],
        ...rest,
      });
      const found = await drafts(h, documentId);
      assert.deepEqual(
        found.map((d) => d.doc),
        draft ? [draft] : [],
      );
    },
  };
}

const neverRan = { results: ["call-1:did_not_run"], edits: [], commands: ["never"], draft: null };
const committed = {
  results: ["call-1:committed"],
  edits: ["call-1"],
  commands: ["done"],
  draft: ["Live seed.", "Added."],
};

/** Discard all on the Work's branch, from a process, as the Review panel's button does. */
const discard = (child: Child, h: Harness, work: { branchId: string }) =>
  child.call({
    op: "discard",
    projectId: h.ids.project,
    branchId: work.branchId,
    userId: h.ids.user,
    commandId: randomUUID(),
  });

const cases: ModelEditCase[] = [
  killedAt(
    "killed before the claim",
    "command.beforeClaim",
    "the call did not run; no draft exists",
    neverRan,
  ),
  killedAt(
    "killed after the claim and the effect, before the commit",
    "command.beforeCommit",
    "the draft's creation and the edit died with the transaction: did not run, no draft",
    neverRan,
  ),
  killedAt(
    "killed after the draft's rows are inserted, before they commit",
    "draft.append.beforeCommit",
    "neither the rows nor their receipt survive: did not run, no draft",
    neverRan,
  ),
  killedAt(
    "killed after the commit, before the result block",
    "block.beforeStore",
    "the draft keeps the edit once, and recovery stores the edit's result",
    committed,
  ),
  {
    name: "killed between two calls of one response",
    expected: "the draft keeps the first call's edit; the second did not run",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "two-calls", "draft");
      const first = await start();
      await first.arm("block.afterStore", "kill");
      await first.script([
        { toolCalls: [insertCall("call-1", path, "Added."), insertCall("call-2", path, "Then.")] },
        reply,
      ]);
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      await recover(start, h, thread);
      assert.deepEqual(await state(h, thread, documentId), {
        doc: SEED,
        turns: ["error"],
        results: ["call-1:committed", "call-2:did_not_run"],
        edits: ["call-1"],
        commands: ["done", "never"],
      });
      assert.deepEqual(
        (await drafts(h, documentId)).map((d) => d.doc),
        [["Live seed.", "Added."]],
      );
    },
  },
  {
    name: "a round writing a draft and a scratch document",
    expected: "the draft takes the manuscript edit, the scratch document is created live",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "round", "draft");
      const first = await start();
      await first.script([
        {
          toolCalls: [
            insertCall("call-1", path, "Added."),
            {
              id: "call-2",
              name: "write",
              args: { command: "create", path: "scratch://Round note", content: "Noted." },
            },
          ],
        },
        reply,
      ]);
      await send(first, h, thread);
      await waitForAssistantTurn(h, thread);
      const after = await state(h, thread, documentId);
      assert.deepEqual(after.results, ["call-1:committed", "call-2:committed"]);
      assert.deepEqual(after.doc, SEED);
      assert.deepEqual(
        (await drafts(h, documentId)).map((d) => d.doc),
        [["Live seed.", "Added."]],
      );
      const [created] = await h.raw`select id from documents where name like 'Round note%'`;
      assert.ok(created, "the scratch document exists");
    },
  },
  {
    name: "a writer types while the model's edit holds the draft",
    expected: "the writer's frame waits for the draft row; the draft ends with both",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "writer-types", "draft");
      const child = await start();
      await child.script([
        { toolCalls: [insertCall("call-1", path, "Added.")] },
        reply,
        { toolCalls: [insertCall("call-2", path, "Then.")] },
        reply,
      ]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      const [draft] = await h.raw<{ id: string }[]>`
        select id from document_drafts where document_id=${documentId} and kind='work_draft'`;
      assert.ok(draft);
      const room = await draftDoc(h, draft.id);
      await child.arm("command.afterLock", "hold");
      await send(child, h, thread, "again");
      await child.at("command.afterLock");
      const typed = h.coordinator.commitWriterUpdate({
        draftId: draft.id,
        updateData: appendToFirstParagraph(room, " typed"),
        roomDocument: room,
      });
      await sleep(1000);
      await child.release("command.afterLock");
      assert.deepEqual(await typed, { admitted: true });
      await waitForAssistantTurn(h, thread, { count: 2 });
      const [found] = await drafts(h, documentId);
      assert.deepEqual(found?.doc, ["Live seed. typed", "Added.", "Then."]);
      assert.deepEqual((await state(h, thread, documentId)).results, [
        "call-1:committed",
        "call-2:committed",
      ]);
    },
  },
  {
    name: "a Discard between two calls of one response",
    expected: "the first call's edit went to the discarded draft; the second is refused, stored",
    async run({ h, start }) {
      const work = await seedWorkWithChats(h, "discard-between", "draft");
      const doc = await h.seedDocument("discard-between", "Live seed.");
      const [{ name }] = await h.raw<
        { name: string }[]
      >`select name from documents where id=${doc.documentId}`;
      const path = `manuscript://${name}`;
      const thread = work.threadIds[0] as string;
      const child = await start();
      await child.arm("block.afterStore", "hold");
      await child.script([
        { toolCalls: [insertCall("call-1", path, "Added."), insertCall("call-2", path, "Then.")] },
        reply,
      ]);
      await send(child, h, thread);
      await child.at("block.afterStore");
      await discard(child, h, work);
      await child.release("block.afterStore");
      await waitForAssistantTurn(h, thread);
      const after = await state(h, thread, doc.documentId);
      assert.deepEqual(after.doc, SEED);
      assert.deepEqual(after.results[0], "call-1:committed");
      assert.notEqual(after.results[1], "call-2:committed");
      assert.deepEqual(after.edits, ["call-1"]);
      assert.deepEqual(
        (await drafts(h, doc.documentId)).map((d) => [d.status, d.doc]),
        [["closed", ["Live seed.", "Added."]]],
      );
      console.log(`  (the second call ended as ${after.results[1]}; commands ${after.commands})`);
    },
  },
  {
    name: "a write after a Discard is refused and its refusal is the stored answer",
    expected:
      "the refusal is stored once; resolving the key again returns it, the draft stays closed",
    async run({ h, start }) {
      const work = await seedWorkWithChats(h, "write-after-discard", "draft");
      const doc = await h.seedDocument("write-after-discard", "Live seed.");
      const [{ name }] = await h.raw<
        { name: string }[]
      >`select name from documents where id=${doc.documentId}`;
      const path = `manuscript://${name}`;
      const thread = work.threadIds[0] as string;
      const child = await start();
      await child.script([
        { toolCalls: [insertCall("call-1", path, "Added.")] },
        reply,
        { toolCalls: [insertCall("call-2", path, "Then.")] },
        reply,
      ]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      await discard(child, h, work);
      await send(child, h, thread, "again");
      await waitForAssistantTurn(h, thread, { count: 2 });
      const after = await state(h, thread, doc.documentId);
      assert.deepEqual(after.results[0], "call-1:committed");
      assert.notEqual(after.results[1], "call-2:committed");
      assert.deepEqual(after.edits, ["call-1"]);
      assert.equal(after.commands[1], "refused");
      const [use] = await h.raw<{ response: string }[]>`
        select b.model_response_id as response from turn_blocks b join turns t on t.id=b.turn_id
        where t.thread_id=${thread} and b.content->>'toolCallId'='call-2' and b.block_type='tool_use'`;
      const again = (await child.call({
        op: "resolve",
        responseId: use?.response,
        toolCallId: "call-2",
        accountId: h.ids.user,
        projectId: h.ids.project,
      })) as { status: string };
      assert.equal(again.status, "refused");
      assert.deepEqual(
        (await drafts(h, doc.documentId)).map((d) => d.status),
        ["closed"],
      );
    },
  },
  {
    name: "a Discard, then another chat writes a new draft",
    expected: "the old draft stays closed with its edit; the new draft holds the new edit alone",
    async run({ h, start }) {
      const work = await seedWorkWithChats(h, "new-draft", "draft", 2);
      const doc = await h.seedDocument("new-draft", "Live seed.");
      const [{ name }] = await h.raw<
        { name: string }[]
      >`select name from documents where id=${doc.documentId}`;
      const path = `manuscript://${name}`;
      const [one, two] = work.threadIds as [string, string];
      const child = await start();
      await child.script([
        { toolCalls: [insertCall("call-1", path, "Added.")] },
        reply,
        { toolCalls: [insertCall("call-2", path, "Then.")] },
        reply,
      ]);
      await send(child, h, one);
      await waitForAssistantTurn(h, one);
      await discard(child, h, work);
      await send(child, h, two);
      await waitForAssistantTurn(h, two);
      const found = await drafts(h, doc.documentId);
      assert.deepEqual(
        found.map((d) => [d.status, d.doc]),
        [
          ["closed", ["Live seed.", "Added."]],
          ["active", ["Live seed.", "Then."]],
        ],
      );
      assert.deepEqual((await state(h, two, doc.documentId)).results, ["call-2:committed"]);
    },
  },
  {
    name: "two chats on one Work's draft",
    expected: "one Work draft holds both chats' edits, each recorded once",
    async run({ h, start }) {
      const work = await seedWorkWithChats(h, "shared-draft", "draft", 2);
      const doc = await h.seedDocument("shared-draft", "Live seed.");
      const [{ name }] = await h.raw<
        { name: string }[]
      >`select name from documents where id=${doc.documentId}`;
      const path = `manuscript://${name}`;
      const [one, two] = work.threadIds as [string, string];
      const child = await start();
      await child.script([
        { toolCalls: [insertCall("call-a", path, "Added.")] },
        reply,
        { toolCalls: [insertCall("call-b", path, "Then.")] },
        reply,
      ]);
      await send(child, h, one);
      await waitForAssistantTurn(h, one);
      await send(child, h, two);
      await waitForAssistantTurn(h, two);
      assert.deepEqual(
        (await drafts(h, doc.documentId)).map((d) => d.doc),
        [["Live seed.", "Added.", "Then."]],
      );
      assert.deepEqual((await state(h, one, doc.documentId)).edits, ["call-a"]);
      assert.deepEqual((await state(h, two, doc.documentId)).edits, ["call-b"]);
    },
  },
];

await runCases("model-edit-drafts", cases);
