/**
 * The crash test of takeover: a second process settles a chat whose run another process still
 * holds or died in, while the old process may come back and try to store. Real processes, the
 * real recovery lanes, stored rows only. The old process's session claim is dropped from the
 * database side (a lost connection), the one way a live process loses its chat.
 *
 *   pnpm exec tsx tools/qa/probes/model-edit-takeover/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a run's stores check its lease row under the thread lock; the takeover ends the row
 * - recovery runs inside the takeover's thread-lock hold and waits there on a held key
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  dropRunClaim,
  insertCall,
  type ModelEditCase,
  namePath,
  runCases,
  seedCase,
  seedWorkWithChats,
  send,
  state,
  waitForAssistantTurn,
  waitForKeyWaiter,
} from "../model-edit-harness/harness.mts";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const reply = { text: "done" };

const cases: ModelEditCase[] = [
  {
    name: "a stale process stores a response after its run was taken over",
    expected: "the store is refused: no call is stored, nothing runs, the turn stays errored once",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "stale-response", "direct");
      const first = await start();
      await first.arm("response.beforeStore", "hold");
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      await first.at("response.beforeStore");
      await dropRunClaim(h, first);
      const second = await start();
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, thread);
      await first.release("response.beforeStore");
      await sleep(1500);
      // Its session connection is gone, so a clean shutdown is not possible: stop it as a crash.
      await first.kill();
      const [{ uses }] = await h.raw<{ uses: number }[]>`
        select count(*)::int as uses from turn_blocks b join turns t on t.id=b.turn_id
        where t.thread_id=${thread} and b.block_type='tool_use'`;
      assert.equal(uses, 0);
      assert.deepEqual(await state(h, thread, documentId), {
        doc: ["Live seed."],
        turns: ["error"],
        results: [],
        edits: [],
        commands: [],
      });
    },
  },
  {
    name: "a stale process stores a result block after its run was taken over",
    expected: "recovery's block stands once; the old process's store is refused",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "stale-block", "direct");
      const first = await start();
      await first.arm("block.beforeStore", "hold");
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      await first.at("block.beforeStore");
      await dropRunClaim(h, first);
      const second = await start();
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, thread);
      await first.release("block.beforeStore");
      await sleep(1500);
      await first.kill();
      assert.deepEqual(await state(h, thread, documentId), {
        doc: ["Live seed.", "Added."],
        turns: ["error"],
        results: ["call-1:committed"],
        edits: ["call-1"],
        commands: ["done"],
      });
    },
  },
  {
    name: "the sweep settles a dead run, then starts the writer's next message",
    expected: "the dead call's committed edit is answered, then the next turn completes",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "sweep-next", "direct");
      const first = await start();
      await first.arm("block.beforeStore", "kill");
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      const second = await start();
      await second.script([reply]);
      // The writer's next message waits behind the dead run's lease; the sweep is what frees it.
      await send(second, h, thread, "next");
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, thread, { count: 2 });
      assert.deepEqual(await state(h, thread, documentId), {
        doc: ["Live seed.", "Added."],
        turns: ["error", "complete"],
        results: ["call-1:committed"],
        edits: ["call-1"],
        commands: ["done"],
      });
    },
  },
  {
    name: "the old process commits while recovery is about to resolve",
    expected: "recovery answers the committed edit; the held transaction was not read as never",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "commit-before-resolve", "direct");
      const first = await start();
      await first.arm("command.afterClaim", "hold");
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      await first.at("command.afterClaim");
      await dropRunClaim(h, first);
      const second = await start();
      await second.arm("recovery.beforeResolve", "hold");
      const swept = second.post({ op: "sweep" });
      await second.at("recovery.beforeResolve");
      // Recovery holds the thread lock and has not asked yet; the held edit now commits.
      await first.release("command.afterClaim");
      await sleep(1000);
      await second.release("recovery.beforeResolve");
      await second.waitFor((m) => m.id === swept);
      await waitForAssistantTurn(h, thread);
      await first.kill();
      const after = await state(h, thread, documentId);
      assert.equal(after.results.length, 1);
      // The old process lost its claim and may abort its edit before the commit; the records
      // agree either way.
      if (after.results[0] === "call-1:committed")
        assert.deepEqual(after, {
          doc: ["Live seed.", "Added."],
          turns: ["error"],
          results: ["call-1:committed"],
          edits: ["call-1"],
          commands: ["done"],
        });
      else
        assert.deepEqual(after, {
          doc: ["Live seed."],
          turns: ["error"],
          results: ["call-1:did_not_run"],
          edits: [],
          commands: ["never"],
        });
      console.log(`  (the held edit ended as ${after.results[0]})`);
    },
  },
  {
    name: "recovery waits on a held key while holding the thread lock",
    expected:
      "the edit commits through the wait; the old process's own store, queued behind the lock, is refused",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "wait-held", "direct");
      const first = await start();
      await first.arm("command.afterClaim", "hold");
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      await first.at("command.afterClaim");
      await dropRunClaim(h, first);
      const second = await start();
      const swept = second.post({ op: "sweep" });
      await waitForKeyWaiter(h);
      await first.release("command.afterClaim");
      await second.waitFor((m) => m.id === swept);
      await waitForAssistantTurn(h, thread);
      await sleep(1000);
      await first.kill();
      const after = await state(h, thread, documentId);
      assert.equal(after.results.length, 1);
      assert.deepEqual(after.turns, ["error"]);
      assert.equal(after.doc.length, after.edits.length + 1);
    },
  },
  {
    name: "recovery waits on a held draft-mode key while holding the thread lock",
    expected:
      "the edit takes no thread row inside its transaction: recovery and the edit do not wait on each other in a cycle",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "wait-held-draft", "draft");
      const first = await start();
      await first.arm("command.afterClaim", "hold");
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      await first.at("command.afterClaim");
      await dropRunClaim(h, first);
      const second = await start();
      const swept = second.post({ op: "sweep" });
      await waitForKeyWaiter(h);
      await first.release("command.afterClaim");
      await second.waitFor((m) => m.id === swept);
      await waitForAssistantTurn(h, thread);
      await sleep(1000);
      await first.kill();
      const after = await state(h, thread, documentId);
      assert.equal(after.results.length, 1);
      assert.deepEqual(after.turns, ["error"]);
    },
  },
  {
    name: "two chats on one document serialize behind the document lock",
    expected: "both edits commit, once each, in the order the lock gave them",
    async run({ h, start }) {
      const work = await seedWorkWithChats(h, "two-chats", "direct", 2);
      const doc = await h.seedDocument("two-chats", "Live seed.");
      const path = await namePath(h, doc.documentId);
      const [one, two] = work.threadIds as [string, string];
      const first = await start();
      await first.arm("command.afterLock", "hold");
      await first.script([{ toolCalls: [insertCall("call-a", path, "Added.")] }, reply]);
      await send(first, h, one);
      await first.at("command.afterLock");
      // Another process, the second chat: its edit waits for the document lock.
      const second = await start();
      await second.script([{ toolCalls: [insertCall("call-b", path, "Then.")] }, reply]);
      await send(second, h, two);
      await sleep(1500);
      assert.deepEqual((await state(h, two, doc.documentId)).doc, ["Live seed."]);
      await first.release("command.afterLock");
      await waitForAssistantTurn(h, one);
      await waitForAssistantTurn(h, two);
      const a = await state(h, one, doc.documentId);
      const b = await state(h, two, doc.documentId);
      assert.deepEqual(a.doc, ["Live seed.", "Added.", "Then."]);
      assert.deepEqual([...a.edits, ...b.edits], ["call-a", "call-b"]);
      assert.deepEqual(a.results, ["call-a:committed"]);
      assert.deepEqual(b.results, ["call-b:committed"]);
    },
  },
  {
    name: "two chats on one Work: one dies mid-edit, the other is untouched",
    expected:
      "the dead chat's call did not run; the other chat's edit stands alone in the document",
    async run({ h, start }) {
      const work = await seedWorkWithChats(h, "one-dies", "direct", 2);
      const doc = await h.seedDocument("one-dies", "Live seed.");
      const path = await namePath(h, doc.documentId);
      const [dying, living] = work.threadIds as [string, string];
      const first = await start();
      await first.arm("command.beforeCommit", "kill");
      await first.script([{ toolCalls: [insertCall("call-a", path, "Lost.")] }, reply]);
      await send(first, h, dying);
      assert.equal(await first.died(), "SIGKILL");
      const second = await start();
      await second.script([{ toolCalls: [insertCall("call-b", path, "Kept.")] }, reply]);
      await send(second, h, living);
      await waitForAssistantTurn(h, living);
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, dying);
      assert.deepEqual(await state(h, dying, doc.documentId), {
        doc: ["Live seed.", "Kept."],
        turns: ["error"],
        results: ["call-a:did_not_run"],
        edits: [],
        commands: ["never"],
      });
      const other = await state(h, living, doc.documentId);
      assert.deepEqual(other.results, ["call-b:committed"]);
      assert.deepEqual(other.edits, ["call-b"]);
    },
  },
  {
    name: "a chat card's Undo sent twice after a kill between its commit and its answer",
    expected:
      "the stored outcome answers the resend (reversed, not nothing to undo); the document is restored once",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "reverse-resend", "direct");
      const first = await start();
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      await waitForAssistantTurn(h, thread);
      const [turn] = await h.raw<{ id: string }[]>`
        select id from turns where thread_id=${thread} and role='assistant'`;
      const undo = {
        op: "reverse",
        threadId: thread,
        userId: h.ids.user,
        turnId: turn?.id,
        commandId: randomUUID(),
        direction: "undo",
      };
      // The first call's own model edit was the command's first commit; the Undo is the second.
      await first.arm("command.afterCommit", "kill", 1);
      first.post(undo);
      assert.equal(await first.died(), "SIGKILL");
      assert.deepEqual((await state(h, thread, documentId)).doc, ["Live seed."]);
      const second = await start();
      const answers = [await second.call(undo), await second.call(undo)] as { status: string }[];
      assert.deepEqual(
        answers.map((answer) => answer.status),
        ["reversed", "reversed"],
      );
      assert.deepEqual((await state(h, thread, documentId)).doc, ["Live seed."]);
    },
  },
];

await runCases("model-edit-takeover", cases);
