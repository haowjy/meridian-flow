/**
 * The crash test of what the model was shown: an edit's frontier is recorded in the edit's own
 * transaction, a read's evidence is handed over after its result block is stored. A process is
 * killed at the steps between and a second one recovers; the frontier rows must agree with the
 * blocks the model was shown. Stored rows only.
 *
 *   pnpm exec tsx tools/qa/probes/model-edit-evidence/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - an edit's evidence commits with the command, under the result block's id; a refused edit
 *   hands over what its answer showed after its block is stored, like a read
 * - a read's evidence is recorded after its block is stored, so a kill between them loses it
 */
import assert from "node:assert/strict";
import {
  frontierSources,
  insertCall,
  type ModelEditCase,
  resultBlockIds,
  runCases,
  seedCase,
  send,
  state,
  waitForAssistantTurn,
} from "../model-edit-harness/harness.mts";

const reply = { text: "done" };
const readCall = (path: string) => ({ id: "call-1", name: "read", args: { path } });

const cases: ModelEditCase[] = [
  {
    name: "an edit killed after its commit keeps its frontier, under the result block's id",
    expected: "one frontier, whose source is the block recovery stored for the call",
    async run({ h, start }) {
      const { thread, path } = await seedCase(h, "edit-frontier", "direct");
      const first = await start();
      await first.arm("command.afterCommit", "kill");
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      const second = await start();
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, thread);
      assert.deepEqual(await frontierSources(h, thread), await resultBlockIds(h, thread));
      assert.equal((await frontierSources(h, thread)).length, 1);
    },
  },
  {
    name: "an edit killed before its commit leaves no frontier",
    expected: "the frontier died with the transaction; the call did not run",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "edit-no-frontier", "direct");
      const first = await start();
      await first.arm("command.beforeCommit", "kill");
      await first.script([{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply]);
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      const second = await start();
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, thread);
      assert.deepEqual(await frontierSources(h, thread), []);
      assert.deepEqual((await state(h, thread, documentId)).results, ["call-1:did_not_run"]);
    },
  },
  {
    name: "a refused edit that showed nothing records no frontier",
    expected:
      "the refusal changed nothing; what its answer showed is recorded after its block is stored",
    async run({ h, start }) {
      const { thread, path } = await seedCase(h, "refused-frontier", "direct");
      const child = await start();
      // The path is taken by the seed document and `overwrite` is not given.
      await child.script([
        {
          toolCalls: [
            { id: "call-1", name: "write", args: { command: "create", path, content: "Other." } },
          ],
        },
        reply,
      ]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      assert.equal((await resultBlockIds(h, thread)).length, 1);
      assert.deepEqual(await frontierSources(h, thread), []);
    },
  },
  {
    name: "a read's frontier is recorded once its block is stored",
    expected: "one frontier, whose source is the read's result block",
    async run({ h, start }) {
      const { thread, path } = await seedCase(h, "read-frontier", "direct");
      const child = await start();
      await child.script([{ toolCalls: [readCall(path)] }, reply]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      assert.deepEqual(await frontierSources(h, thread), await resultBlockIds(h, thread));
      assert.equal((await frontierSources(h, thread)).length, 1);
    },
  },
  {
    name: "a read killed after its block is stored, before its evidence",
    expected: "the block stands and no frontier exists: the read's evidence is lost with the kill",
    async run({ h, start }) {
      const { thread, path } = await seedCase(h, "read-lost", "direct");
      const first = await start();
      await first.arm("block.afterStore", "kill");
      await first.script([{ toolCalls: [readCall(path)] }, reply]);
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      const second = await start();
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, thread);
      assert.equal((await resultBlockIds(h, thread)).length, 1);
      assert.deepEqual(await frontierSources(h, thread), []);
    },
  },
];

await runCases("model-edit-evidence", cases);
