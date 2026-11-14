/**
 * The crash test of the model's tree commands (`create`, `copy`, `move`, `delete`) and its
 * `undo`, through the real chat loop: a process is killed after the command commits and before
 * its result block, a second process recovers, and the tree must show the command once with
 * its result the model's. Stored rows only.
 *
 *   pnpm exec tsx tools/qa/probes/model-edit-tree/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a tree command is one model-edit command under its call's key, like a text edit
 * - a create with content is undone as one edit (the node and its text)
 */
import assert from "node:assert/strict";
import {
  documentsNamed,
  insertCall,
  type ModelEditCase,
  runCases,
  seedCase,
  send,
  state,
  waitForAssistantTurn,
} from "../model-edit-harness/harness.mts";

const reply = { text: "done" };
type Harness = Parameters<typeof state>[0];

const write = (id: string, args: Record<string, unknown>) => ({ id, name: "write", args });

/** A tree command killed at `point` and recovered; `check` reads the tree afterwards. */
function killed(
  name: string,
  expected: string,
  point: string,
  command: (path: string, tag: string) => Record<string, unknown>,
  check: (h: Harness, tag: string) => Promise<void>,
): ModelEditCase {
  return {
    name,
    expected,
    async run({ h, start }) {
      const tag = `t${Math.random().toString(36).slice(2, 8)}`;
      const { thread, documentId, path } = await seedCase(h, tag, "direct");
      const first = await start();
      await first.arm(point, "kill");
      await first.script([{ toolCalls: [write("call-1", command(path, tag))] }, reply]);
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      const second = await start();
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, thread);
      const after = await state(h, thread, documentId);
      assert.deepEqual(after.results, ["call-1:committed"]);
      assert.deepEqual(after.commands, ["done"]);
      assert.deepEqual(after.turns, ["error"]);
      await check(h, tag);
    },
  };
}

const cases: ModelEditCase[] = [
  killed(
    "move killed after commit, before its block",
    "the document is renamed once and the block is the move's result",
    "command.afterCommit",
    (path, tag) => ({ command: "move", from: { path }, path: `manuscript://${tag}-moved` }),
    async (h, tag) => {
      const found = await documentsNamed(h, tag);
      assert.deepEqual(
        found.map((d) => [d.name.replace(tag, "T"), d.deleted]),
        [["T-moved", false]],
      );
    },
  ),
  killed(
    "delete killed after commit, before its block",
    "the document is deleted once and the block is the delete's result",
    "block.beforeStore",
    (path) => ({ command: "delete", path }),
    async (h, tag) => {
      assert.deepEqual(
        (await documentsNamed(h, tag)).map((d) => d.deleted),
        [true],
      );
    },
  ),
  killed(
    "create with content killed after commit, before its block",
    "the new document exists once with its text, and the block is the create's result",
    "command.afterCommit",
    (_path, tag) => ({ command: "create", path: `manuscript://${tag}-new`, content: "Fresh." }),
    async (h, tag) => {
      const found = await documentsNamed(h, `${tag}-new`);
      assert.equal(found.length, 1);
      assert.equal(found[0]?.deleted, false);
      assert.deepEqual((await h.liveText(found[0]?.id as string)).includes("Fresh."), true);
    },
  ),
  killed(
    "copy killed after commit, before its block",
    "the copy exists once and the original is unchanged",
    "block.beforeStore",
    (path, tag) => ({ command: "copy", from: { path }, path: `manuscript://${tag}-copy` }),
    async (h, tag) => {
      const found = await documentsNamed(h, tag);
      assert.deepEqual(
        found.map((d) => d.name.replace(tag, "T")).filter((name) => name.includes("copy")),
        ["T-copy"],
      );
      assert.equal(found.length, 2);
    },
  ),
  {
    name: "a create refused after the claim leaves no node",
    expected: "the refusal is the stored outcome; no document appears under the name",
    async run({ h, start }) {
      const tag = `t${Math.random().toString(36).slice(2, 8)}`;
      const { thread, documentId, path } = await seedCase(h, tag, "direct");
      const child = await start();
      // The path is taken by the seed document and `overwrite` is not given.
      await child.script([
        { toolCalls: [write("call-1", { command: "create", path, content: "Other." })] },
        reply,
      ]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      const after = await state(h, thread, documentId);
      assert.equal(after.commands[0], "refused");
      assert.deepEqual(after.doc, ["Live seed."]);
      assert.equal((await documentsNamed(h, tag)).length, 1);
    },
  },
  {
    name: "the model's undo of a create with content",
    expected: "one undo takes the new document and its text together",
    async run({ h, start }) {
      const tag = `t${Math.random().toString(36).slice(2, 8)}`;
      const { thread, documentId } = await seedCase(h, tag, "direct");
      const child = await start();
      const born = `manuscript://${tag}-born`;
      await child.script([
        { toolCalls: [write("call-1", { command: "create", path: born, content: "Fresh." })] },
        reply,
        { toolCalls: [write("call-2", { command: "undo", path: born })] },
        reply,
      ]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      await send(child, h, thread, "undo it");
      await waitForAssistantTurn(h, thread, { count: 2 });
      const after = await state(h, thread, documentId);
      assert.deepEqual(after.results, ["call-1:committed", "call-2:committed"]);
      const found = await documentsNamed(h, `${tag}-born`);
      assert.deepEqual(
        found.map((d) => d.deleted),
        [true],
      );
    },
  },
  {
    name: "the model's undo killed after commit",
    expected: "the document is restored once and recovery stores the undo's own result",
    async run({ h, start }) {
      const tag = `t${Math.random().toString(36).slice(2, 8)}`;
      const { thread, documentId, path } = await seedCase(h, tag, "direct");
      const first = await start();
      // The first model edit is the 1st command commit; the undo is the 2nd.
      await first.arm("command.afterCommit", "kill", 2);
      await first.script([
        { toolCalls: [insertCall("call-1", path, "Added.")] },
        reply,
        { toolCalls: [write("call-2", { command: "undo", path })] },
        reply,
      ]);
      await send(first, h, thread);
      await waitForAssistantTurn(h, thread);
      await send(first, h, thread, "undo it");
      assert.equal(await first.died(), "SIGKILL");
      const second = await start();
      await second.call({ op: "sweep" });
      await waitForAssistantTurn(h, thread, { count: 2 });
      assert.deepEqual(await state(h, thread, documentId), {
        doc: ["Live seed."],
        turns: ["complete", "error"],
        results: ["call-1:committed", "call-2:committed"],
        edits: ["call-1", "call-2"],
        commands: ["done", "done"],
      });
    },
  },
  {
    name: "a duplicate tool-call id in one response",
    expected: "the response is refused when stored: no call runs, the turn errors",
    async run({ h, start }) {
      const tag = `t${Math.random().toString(36).slice(2, 8)}`;
      const { thread, documentId, path } = await seedCase(h, tag, "direct");
      const child = await start();
      await child.script([
        {
          toolCalls: [insertCall("dup", path, "Added."), insertCall("dup", path, "Again.")],
        },
        reply,
      ]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      const after = await state(h, thread, documentId);
      assert.deepEqual(after, {
        doc: ["Live seed."],
        turns: ["error"],
        results: [],
        edits: [],
        commands: [],
      });
    },
  },
  {
    name: "a create aborted after the claim leaves no node",
    expected:
      "the timeout aborts the held create; its rollback leaves no document, the key is never",
    async run({ h, start }) {
      const tag = `t${Math.random().toString(36).slice(2, 8)}`;
      const { thread, documentId } = await seedCase(h, tag, "direct");
      const child = await start();
      await child.timeout("write", 1000);
      await child.arm("command.afterClaim", "hold");
      await child.script([
        {
          toolCalls: [
            write("call-1", {
              command: "create",
              path: `manuscript://${tag}-aborted`,
              content: "Never.",
            }),
          ],
        },
        reply,
      ]);
      await send(child, h, thread);
      await child.at("command.afterClaim");
      await new Promise((done) => setTimeout(done, 2000));
      await child.release("command.afterClaim");
      await waitForAssistantTurn(h, thread);
      const after = await state(h, thread, documentId);
      assert.deepEqual(after.results, ["call-1:timeout"]);
      assert.deepEqual(after.commands, ["never"]);
      assert.equal((await documentsNamed(h, `${tag}-aborted`)).length, 0);
    },
  },
];

await runCases("model-edit-tree", cases);
