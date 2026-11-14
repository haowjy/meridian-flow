/**
 * The crash test of the model's edits, through the real chat loop: a composed server in a child
 * process runs a chat turn on the mock model, the parent kills it (SIGKILL) at a named step, and
 * a second process takes the chat over and recovers. Asserts on stored rows only.
 *
 *   pnpm exec tsx tools/qa/probes/model-edit-kills/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - the held path: a staged write that dies before its reply's save is rolled back with the run
 * - a dead run's turn ends in `error` with the failure code `orphaned`
 */
import assert from "node:assert/strict";
import {
  insertCall,
  type ModelEditCase,
  rows,
  runCases,
  seedCase,
  send,
  waitForAssistantTurn,
} from "../model-edit-harness/harness.mts";

const cases: ModelEditCase[] = [
  {
    name: "held-path write, killed at the reply's save, recovered",
    expected: "the document keeps its seed, the dead turn errors once, the write left no receipt",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "held-save", "direct");
      const first = await start();
      await first.arm("save.afterDocumentLock", "kill");
      await first.script([
        { responseId: "resp-1", toolCalls: [insertCall("call-1", path, "Added by the model.")] },
        { text: "done" },
      ]);
      await send(first, h, thread);
      assert.equal(await first.exited, "SIGKILL");

      const second = await start();
      await second.call({ op: "sweep" });
      const turn = await waitForAssistantTurn(h, thread);
      const after = await rows(h, thread, documentId);
      assert.equal(turn.status, "error");
      assert.equal(after.text, "<paragraph>Live seed.</paragraph>");
      assert.equal(after.turns.filter((t) => t.role === "assistant").length, 1);
      assert.equal(after.edits.length, 0);
    },
  },
];

await runCases("model-edit-kills", cases);
