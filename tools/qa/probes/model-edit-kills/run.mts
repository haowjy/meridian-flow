/**
 * The crash test of the model's edits to a live document, through the real chat loop: a composed
 * server in a child process runs a chat turn on the mock model, the parent kills it (SIGKILL) at
 * a named step or holds it there, and a second process takes the chat over and recovers. Asserts
 * on stored rows only: the document, the edit receipts, the result blocks, the command rows.
 *
 *   pnpm exec tsx tools/qa/probes/model-edit-kills/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a dead run's turn ends in `error`, and recovery answers each open `write` call from its key:
 *   a committed edit's own result, or "did not run"
 * - a tool timeout settles the call through its key, so a late claim finds `never`
 */
import assert from "node:assert/strict";
import {
  type Child,
  dropRunClaim,
  insertCall,
  type ModelEditCase,
  runCases,
  seedCase,
  send,
  state,
  waitForAssistantTurn,
  waitForKeyWaiter,
} from "../model-edit-harness/harness.mts";

const SEED = ["Live seed."];
const ADDED = ["Live seed.", "Added."];
const reply = { text: "done" };

/** One write call that inserts "Added.", then the closing reply. */
const oneCall = (path: string) => [{ toolCalls: [insertCall("call-1", path, "Added.")] }, reply];

/** What a takeover process does to a dead one's chat: the orphan sweep, then waiting for it to settle. */
async function recover(
  start: () => Promise<Child>,
  h: Parameters<typeof state>[0],
  thread: string,
) {
  const second = await start();
  await second.call({ op: "sweep" });
  await waitForAssistantTurn(h, thread);
}

/** A write killed at `point`; the document and the result block agree afterwards, whichever side of the commit. */
function killedAt(
  name: string,
  point: string,
  expected: string,
  after: Partial<Awaited<ReturnType<typeof state>>>,
): ModelEditCase {
  return {
    name,
    expected,
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, name, "direct");
      const first = await start();
      await first.arm(point, "kill");
      await first.script(oneCall(path));
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      await recover(start, h, thread);
      assert.deepEqual(await state(h, thread, documentId), { turns: ["error"], ...after });
    },
  };
}

const neverRan = { doc: SEED, results: ["call-1:did_not_run"], edits: [], commands: ["never"] };
const committed = {
  doc: ADDED,
  results: ["call-1:committed"],
  edits: ["call-1"],
  commands: ["done"],
};

/** Two responses of one turn each call `call-1` (some adapters number calls per response); the second is killed at `point`. */
function reusedCallId(
  name: string,
  spec: {
    point: string;
    expected: string;
    after: Partial<Awaited<ReturnType<typeof state>>>;
  },
): ModelEditCase[] {
  return [
    {
      name,
      expected: spec.expected,
      async run({ h, start }) {
        const { thread, documentId, path } = await seedCase(h, name, "direct");
        const first = await start();
        await first.arm(spec.point, "kill", 2);
        await first.script([
          { toolCalls: [insertCall("call-1", path, "First.")] },
          { toolCalls: [insertCall("call-1", path, "Second.")] },
          reply,
        ]);
        await send(first, h, thread);
        assert.equal(await first.died(), "SIGKILL");
        await recover(start, h, thread);
        assert.deepEqual(await state(h, thread, documentId), { turns: ["error"], ...spec.after });
      },
    },
  ];
}

const cases: ModelEditCase[] = [
  {
    name: "killed before its response is stored: nothing ran",
    expected: "no call, no edit, no command: the turn errors with only the writer's message",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "kill-response", "direct");
      const first = await start();
      await first.arm("response.beforeStore", "kill");
      await first.script(oneCall(path));
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      await recover(start, h, thread);
      const after = await state(h, thread, documentId);
      assert.deepEqual(after, {
        doc: SEED,
        turns: ["error"],
        results: [],
        edits: [],
        commands: [],
      });
    },
  },
  killedAt(
    "killed before the claim",
    "command.beforeClaim",
    "the call did not run: the document keeps its seed, the key is settled never",
    { ...neverRan },
  ),
  killedAt(
    "killed after the claim and the effect, before the commit",
    "command.beforeCommit",
    "the transaction died with the process: did not run, no receipt",
    { ...neverRan },
  ),
  killedAt(
    "killed after the commit, before the answer",
    "command.afterCommit",
    "the edit stays once, and the result block is the edit's own",
    { ...committed },
  ),
  killedAt(
    "killed before the result block is stored",
    "block.beforeStore",
    "the edit stays once, and recovery stores the edit's result",
    { ...committed },
  ),
  killedAt(
    "killed while the result block is stored",
    "block.duringStore",
    "the block row died uncommitted: recovery stores the edit's result once",
    { ...committed },
  ),
  killedAt(
    "killed after the result block is stored",
    "block.afterStore",
    "nothing is open: the edit and its block are as the run left them",
    { ...committed },
  ),
  {
    name: "killed between two calls of one response",
    expected: "the first call stays with its block, the second did not run",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "two-calls", "direct");
      const first = await start();
      await first.arm("block.afterStore", "kill");
      await first.script([
        {
          toolCalls: [insertCall("call-1", path, "Added."), insertCall("call-2", path, "Then.")],
        },
        reply,
      ]);
      await send(first, h, thread);
      assert.equal(await first.died(), "SIGKILL");
      await recover(start, h, thread);
      const after = await state(h, thread, documentId);
      assert.deepEqual(after, {
        doc: ADDED,
        turns: ["error"],
        results: ["call-1:committed", "call-2:did_not_run"],
        edits: ["call-1"],
        commands: ["done", "never"],
      });
    },
  },
  ...reusedCallId("killed after the commit of a call whose id an earlier response used", {
    point: "command.afterCommit",
    expected: "the later edit's own result is stored beside the first's: two results, two edits",
    after: {
      doc: ["Live seed.", "First.", "Second."],
      results: ["call-1:committed", "call-1:committed"],
      edits: ["call-1", "call-1"],
      commands: ["done", "done"],
    },
  }),
  ...reusedCallId("killed before the claim of a call whose id an earlier response used", {
    point: "command.beforeClaim",
    expected: "the later call did not run; the earlier result is not taken for it",
    after: {
      doc: ["Live seed.", "First."],
      results: ["call-1:committed", "call-1:did_not_run"],
      edits: ["call-1"],
      commands: ["done", "never"],
    },
  }),
  {
    name: "the old process alive and held after the claim: recovery waits on the key",
    expected:
      "recovery's resolve waits for the held transaction; the document, result block and command row agree",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "alive-held", "direct");
      const first = await start();
      await first.arm("command.afterClaim", "hold");
      await first.script(oneCall(path));
      await send(first, h, thread);
      await first.at("command.afterClaim");
      // The session claim drops (a lost connection): the chat can be taken over while this
      // process is alive and its transaction holds the key.
      await dropRunClaim(h, first);
      const second = await start();
      const swept = second.post({ op: "sweep" });
      await waitForKeyWaiter(h);
      await first.release("command.afterClaim");
      await second.waitFor((m) => m.id === swept);
      await waitForAssistantTurn(h, thread);
      const after = await state(h, thread, documentId);
      // The old process may notice its lost claim and abort the edit before its commit, or commit
      // it; either way the three records say the same thing, once.
      assert.deepEqual(after.turns, ["error"]);
      assert.equal(after.results.length, 1);
      console.log(`  (the held edit ended as ${after.results[0]})`);
      if (after.results[0] === "call-1:committed")
        assert.deepEqual(after, { ...committed, turns: ["error"] });
      else assert.deepEqual(after, { ...neverRan, turns: ["error"] });
    },
  },
  {
    name: "a committed call's key resolved again",
    expected: "the stored outcome answers, not a second edit: one edit, one receipt, one command",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "resolve-again", "direct");
      const first = await start();
      await first.script(oneCall(path));
      await send(first, h, thread);
      await waitForAssistantTurn(h, thread);
      const [use] = await h.raw<{ response: string }[]>`
        select b.model_response_id as response from turn_blocks b join turns t on t.id=b.turn_id
        where t.thread_id=${thread} and b.block_type='tool_use'`;
      const second = await start();
      const key = {
        op: "resolve",
        threadId: thread,
        responseId: use?.response,
        toolCallId: "call-1",
        accountId: h.ids.user,
        projectId: h.ids.project,
      };
      const answers = [await second.call(key), await second.call(key)] as {
        status: string;
      }[];
      assert.deepEqual(
        answers.map((answer) => answer.status),
        ["done", "done"],
      );
      assert.deepEqual(await state(h, thread, documentId), { ...committed, turns: ["complete"] });
    },
  },
  {
    name: "a write with missing content, in a turn that finishes normally",
    expected:
      "the call has one result block, the executor's invalid-arguments error: recovery adds none",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "invalid-input", "direct");
      const child = await start();
      await child.script([
        { toolCalls: [{ id: "call-1", name: "write", args: { command: "insert", path } }] },
        reply,
      ]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      assert.deepEqual(await state(h, thread, documentId), {
        doc: SEED,
        turns: ["complete"],
        results: ["call-1:unknown"],
        edits: [],
        commands: [],
      });
    },
  },
  {
    name: "a write outside the agent's tools, in a turn that finishes normally",
    expected: "the call has one result block, the refusal: recovery adds none",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "tool-denied", "direct");
      const child = await start();
      await child.script(oneCall(path));
      await send(child, h, thread, "go", ["write"]);
      await waitForAssistantTurn(h, thread);
      assert.deepEqual(await state(h, thread, documentId), {
        doc: SEED,
        turns: ["complete"],
        results: ["call-1:unknown"],
        edits: [],
        commands: [],
      });
    },
  },
  {
    name: "tool timeout before the claim",
    expected: "the call is settled never: the late claim finds that and changes nothing",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "timeout-before", "direct");
      const child = await start();
      await child.timeout("write", 1000);
      await child.arm("command.beforeClaim", "hold");
      await child.script(oneCall(path));
      await send(child, h, thread);
      await child.at("command.beforeClaim");
      await waitForAssistantTurn(h, thread);
      await child.release("command.beforeClaim");
      await new Promise((done) => setTimeout(done, 1000));
      assert.deepEqual(await state(h, thread, documentId), {
        doc: SEED,
        turns: ["complete"],
        results: ["call-1:timeout"],
        edits: [],
        commands: ["never"],
      });
    },
  },
  {
    name: "tool timeout after the claim",
    expected: "resolve waits for the held transaction; the abort-aware effect rolls back: never",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "timeout-after", "direct");
      const child = await start();
      await child.timeout("write", 1000);
      await child.arm("command.afterClaim", "hold");
      await child.script(oneCall(path));
      await send(child, h, thread);
      await child.at("command.afterClaim");
      // Past the timeout the runtime resolves the key and waits on the held claim. With the
      // pool at 2 (the claim's transaction and the session lock hold both connections) it waits
      // for a connection, so no database lock waiter shows; wait out the timeout instead.
      await new Promise((done) => setTimeout(done, 2000));
      await child.release("command.afterClaim");
      await waitForAssistantTurn(h, thread);
      assert.deepEqual(await state(h, thread, documentId), {
        doc: SEED,
        turns: ["complete"],
        results: ["call-1:timeout"],
        edits: [],
        commands: ["never"],
      });
    },
  },
];

await runCases("model-edit-kills", cases);
