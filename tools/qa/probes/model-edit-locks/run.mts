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
import { gate, Y } from "../model-edit-harness/scratch.mts";

type Harness = Parameters<typeof state>[0];

const reply = { text: "done" };

/** The chat's latest assistant turn's id. */
async function lastTurn(h: Harness, threadId: string) {
  const [turn] = await h.raw<{ id: string }[]>`
    select id from turns where thread_id=${threadId} and role='assistant'
    order by position desc limit 1`;
  if (!turn) throw new Error("the chat has no assistant turn");
  return turn.id;
}

/** A chat card's Undo of the turn, as the route sends it. */
const undoOf = (h: Harness, threadId: string, turnId: string) => ({
  op: "reverse",
  threadId,
  userId: h.ids.user,
  turnId,
  commandId: randomUUID(),
  direction: "undo",
});

/** Waits until `count` of the child's connections wait on a database lock. */
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

/**
 * `promise`, or a failure once `ms` pass naming `what` and the state of the child's connections:
 * a hang on a process mutex shows as one idle in transaction and one waiting on a lock.
 */
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

/**
 * Holds `lock` on the probe's own connection until `release` is called; resolves once taken.
 * `then` runs in the same transaction after the release, before it commits.
 */
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

/** The live document with `suffix` typed at the end of paragraph `index`, as a human frame. */
async function writerTypes(h: Harness, documentId: string, index: number, suffix: string) {
  const doc = await h.liveDoc(documentId);
  try {
    const before = Y.encodeStateVector(doc);
    const paragraph = doc.getXmlFragment("prosemirror").get(index) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    text.insert(text.length, suffix);
    await h.persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${h.ids.user}`,
      seq: 0,
    });
  } finally {
    doc.destroy();
  }
}

const cases: ModelEditCase[] = [
  {
    name: "the writer types into the model's paragraph while its Undo captures the document",
    expected: "the writer's typing is inside the model's paragraph: the Undo leaves it whole",
    async run({ h, start }) {
      const { thread, documentId, path } = await seedCase(h, "capture", "direct");
      const child = await start();
      await child.script([{ toolCalls: [insertCall("call-1", path, "Agent paragraph.")] }, reply]);
      await send(child, h, thread);
      await waitForAssistantTurn(h, thread);
      await child.arm("inverse.afterCaptureRead", "hold");
      const undo = child.call(undoOf(h, thread, await lastTurn(h, thread)));
      await child.at("inverse.afterCaptureRead");
      await writerTypes(h, documentId, 1, " Writer keeps this.");
      await child.release("inverse.afterCaptureRead");
      const answer = (await undo) as {
        status: string;
        documents: { status: string }[];
        skips?: { cause: string }[];
      };
      assert.deepEqual((await state(h, thread, documentId)).doc, [
        "Live seed.",
        "Agent paragraph. Writer keeps this.",
      ]);
      assert.equal(answer.status === "success", false);
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
      // The turn also renamed the other Work: a receipt the card's Undo puts back.
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
      // Another transaction holds the Work, then wants the document, the order a model edit takes.
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
