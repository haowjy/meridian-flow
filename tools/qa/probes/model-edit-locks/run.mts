/**
 * The lock order of document commands, through the real chat loop and a chat card's Undo: two
 * commands, or a command and another transaction, racing for the same Work and document. The
 * parent holds a lock from its own connection to line the racers up in the order that used to
 * hang, lose text or store a deadlock as an answer. Asserts on stored rows only.
 *
 *   pnpm exec tsx tools/qa/probes/model-edit-locks/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a card Undo reverses the turn's Work receipts after the documents' command commits
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  type Child,
  insertCall,
  type ModelEditCase,
  runCases,
  seedCase,
  seedWorkWithChats,
  send,
  state,
  waitForAssistantTurn,
} from "../model-edit-harness/harness.mts";
import { gate } from "../model-edit-harness/scratch.mts";

type Harness = Parameters<typeof state>[0];

const reply = { text: "done" };

async function lastTurn(h: Harness, threadId: string) {
  const [turn] = await h.raw<{ id: string }[]>`
    select id from turns where thread_id=${threadId} and role='assistant'
    order by position desc limit 1`;
  if (!turn) throw new Error("the chat has no assistant turn");
  return turn.id;
}

const undoOf = (h: Harness, threadId: string, turnId: string) => ({
  op: "reverse",
  threadId,
  userId: h.ids.user,
  turnId,
  commandId: randomUUID(),
  direction: "undo",
});

async function lockWaiters(h: Harness, child: Child, count: number, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.raw`
      select 1 from pg_stat_activity
      where datname=current_database() and application_name=${child.name}
        and wait_event_type='Lock'`;
    if (rows.length >= count) return;
    if (Date.now() > until)
      throw new Error(`${rows.length} of the child's connections wait on a lock, not ${count}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

async function _within<T>(
  h: Harness,
  child: Child,
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), ms);
  });
  const settled = await Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  if (settled !== "timeout") return settled;
  const connections = await h.raw<{ state: string; wait: string | null }[]>`
    select state, wait_event_type as wait from pg_stat_activity
    where datname=current_database() and application_name=${child.name}`;
  const described = connections.map((c) => `${c.state}${c.wait ? ` (${c.wait})` : ""}`);
  throw new Error(`${what} hung; the child's connections: ${described.join(", ")}`);
}

async function holdLock(
  h: Harness,
  lock: (sql: typeof h.raw) => Promise<unknown>,
  then?: (sql: typeof h.raw) => Promise<unknown>,
) {
  const taken = gate();
  const released = gate();
  const done = h.raw.begin(async (sql) => {
    await lock(sql as unknown as typeof h.raw);
    taken.open();
    await released.wait;
    await then?.(sql as unknown as typeof h.raw);
  });
  await taken.wait;
  return { release: released.open, done };
}

const cases: ModelEditCase[] = [
  {
    name: "the writer types into the model's paragraph while its Undo captures the document",
    expected:
      "the Undo runs: the model's words go and the writer's typing, which its capture did not read, stays",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "capture", "direct");
      const child = await start();
      await child.script([{ toolCalls: [insertCall("call-1", path, "Agent paragraph.")] }, reply]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      await child.arm("inverse.afterCaptureRead", "hold");
      const undo = child.call(undoOf(h, thread, await lastTurn(h, thread)));
      await child.at("inverse.afterCaptureRead");
      await h.writerTypes(documentId, 1, " Writer keeps this.");
      await child.release("inverse.afterCaptureRead");
      const answer = (await undo) as {
        status: string;
        documents: { status: string }[];
        skips?: { cause: string }[];
      };
      assert.deepEqual((await state(h, thread, documentId)).doc, [
        "Live seed.",
        " Writer keeps this.",
      ]);
      assert.equal(answer.status, "reversed");
    },
  },
  {
    name: "a card Undo's Work receipt waits on a Work whose holder then wants the document",
    expected:
      "the Work receipt reverses after the documents' command committed: no deadlock, and a resend answers the same",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "receipt", "direct");
      const other = await seedWorkWithChats(h, "receipt-work", "direct");
      const child = await start();
      await child.script([{ toolCalls: [insertCall("call-1", path, "Agent paragraph.")] }, reply]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      const turnId = await lastTurn(h, thread);
      const [work] = await h.raw<{ name: string; goal: string | null; status: string | null }[]>`
        select name, goal, status from works where id=${other.workId}`;
      if (!work) throw new Error("the Work is missing");
      const after = { name: work.name, goal: work.goal, status: work.status, archived: false };
      const before = { ...after, name: `${work.name} before` };
      await h.raw`
        insert into turn_blocks(turn_id, block_type, sequence, content)
        values (${turnId}, 'tool_result',
          (select coalesce(max(sequence), 0) + 1 from turn_blocks where turn_id=${turnId}),
          ${h.raw.json({
            metadata: {
              workReceipt: {
                operation: "update",
                changed: true,
                workId: other.workId,
                workName: work.name,
                before,
                after,
                inverse: { command: "update", workId: other.workId, state: before },
              },
            },
          })})`;
      const holder = await holdLock(
        h,
        async (sql) => {
          await sql`set local deadlock_timeout = '10s'`;
          await sql`select id from works where id=${other.workId} for no key update`;
        },
        (sql) =>
          sql`select pg_advisory_xact_lock(hashtextextended(${`document-mutation:${documentId}`}, 0::bigint))`,
      );
      const undo = undoOf(h, thread, turnId);
      const first = child.call(undo, 30_000);
      try {
        await lockWaiters(h, child, 1);
      } finally {
        holder.release();
        await holder.done;
      }
      const answers = [(await first) as { status: string }];
      answers.push((await child.call(undo)) as { status: string });
      assert.deepEqual(
        answers.map((answer) => answer.status),
        ["reversed", "reversed"],
      );
      assert.deepEqual((await state(h, thread, documentId)).doc, ["Live seed."]);
      const [renamed] = await h.raw<{ name: string }[]>`
        select name from works where id=${other.workId}`;
      assert.equal(renamed?.name, before.name);
    },
  },
];

await runCases("model-edit-locks", cases);
