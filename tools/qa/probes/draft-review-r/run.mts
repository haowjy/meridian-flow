/** R acceptance: content rebases and late frames through production services and PostgreSQL. */

import assert from "node:assert/strict";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { createDrizzleTurnInverseService } from "../../../../apps/server/server/domains/collab/adapters/drizzle-turn-inverse.ts";
import { createDraftCoordinator } from "../../../../apps/server/server/domains/collab/domain/draft-coordinator.ts";
import { createDraftProjection } from "../../../../apps/server/server/domains/collab/domain/draft-projection.ts";
import { createDraftPullService } from "../../../../apps/server/server/domains/collab/domain/draft-pulls.ts";
import { commitDraftRows } from "../../../../apps/server/server/domains/collab/test-support/draft-update-writes.ts";
import { createAllowAllFileAccess } from "../../../../apps/server/server/domains/file-policy/index.ts";
import {
  runInRootDrizzleTransaction,
  runOutsideWrite,
} from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import { runWithEditConfirmation } from "../../../../apps/server/server/shared/edit-confirmation.ts";
import { setTestHook } from "../../../../apps/server/server/shared/test-hooks.ts";
import { createTestRemovalDeps } from "../../../../apps/server/server/test-support/document-removal.ts";
import {
  blocksEqual,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "../../../../packages/agent-edit/src/diff/index.ts";
import { captureMutationUpdates } from "../../../../packages/agent-edit/src/yjs-mutation.ts";
import { workGrant } from "../drafts-lock-free/f1-inverse-grant.mts";
import { createScratchDatabase, openHarness } from "../drafts-lock-free/harness.mts";

const schema = buildDocumentSchema();
const paragraph = (text: string) =>
  schema.nodes.paragraph.create({ id: "p" }, text ? schema.text(text) : null);
// A quote is the same block with a `>` step: wrapping keeps its element and its id.
const quote = (text: string) =>
  schema.nodes.paragraph.create({ id: "p", path: ">" }, text ? schema.text(text) : null);
// Retyping to a code block replaces the element, so late frames on the paragraph need recovery.
const rebuilt = (text: string) =>
  schema.nodes.code_block.create({ id: "c" }, text ? schema.text(text) : null);
const scratch = await createScratchDatabase();
const h = await openHarness(scratch.url);
const docs: Y.Doc[] = [];
const coordinator = createDraftCoordinator({
  store: h.store,
  attemptScope: h.attemptScope,
  onAppendCommitted: (id) => effect.markDirty(id),
});
const effect = createDraftProjection({
  coordinator,
  store: h.store,
  outsideTransaction: runOutsideWrite,
});
const liveCoordinator = {
  async withDocument<T>(id: string, fn: (doc: Y.Doc) => Promise<T>) {
    const doc = await h.liveDoc(id);
    try {
      return await fn(doc);
    } finally {
      doc.destroy();
    }
  },
  deliver: async () => {},
};
const pulls = createDraftPullService({
  outsideTransaction: runOutsideWrite,
  draftCoordinator: coordinator,
  drafts: h.store,
  liveJournal: h.persistence.journal,
});
const fragment = (doc: Y.Doc) => doc.getXmlFragment("prosemirror");
const blocks = (doc: Y.Doc) => readBlocks(fragment(doc), schema);
const clone = (doc: Y.Doc) => {
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  docs.push(copy);
  return copy;
};
const textAt = (doc: Y.Doc, at = 0) => (fragment(doc).get(at) as Y.XmlElement).get(0) as Y.XmlText;
const captured = (doc: Y.Doc, edit: () => void) =>
  Y.mergeUpdates(captureMutationUpdates(doc, edit));
async function seed(label: string, content = [paragraph("Base words.")]) {
  const work = await h.seedWork(label);
  const seeded = await h.seedDocument(label, "");
  docs.push(seeded.live);
  const initial = captured(seeded.live, () => writeBlocks(fragment(seeded.live), schema, content));
  await h.persistence.journal.append(seeded.documentId, initial, { origin: "system", seq: 0 });
  const draft = await h.store.ensureDocumentDraft({
    ...seeded,
    branchId: work.branchId,
    liveDoc: seeded.live,
    liveRoom: null,
  });
  const room = await coordinator.readDraft(draft.draftId, async (doc) => clone(doc));
  assert.ok([...Y.decodeStateVector(Y.encodeStateVector(room)).keys()].every((id) => id === 1));
  assert.ok(
    blocksEqual(blocks(room), readBlocks(room.getXmlFragment(REVIEW_BASE_FRAGMENT), schema)),
  );
  return { ...seeded, ...draft, ...work, room };
}
type Seed = Awaited<ReturnType<typeof seed>>;
async function writer(s: Seed, update: Uint8Array) {
  return coordinator.commitWriterUpdate({
    draftId: s.draftId,
    updateData: update,
    actorUserId: h.ids.user,
    roomDocument: s.room,
  });
}
async function agent(s: Seed, update: Uint8Array, peer: Y.Doc) {
  const wId = await h.persistence.journal.reserveWriteOrdinal(s.documentId, s.threadId);
  return commitDraftRows(coordinator, {
    draftId: s.draftId,
    sourceDoc: peer,
    rows: [
      {
        draftId: s.draftId,
        updateData: update,
        source: "agent",
        threadId: s.threadId,
        turnId: s.turnId,
        wId,
      },
    ],
  });
}
async function live(s: Seed, content: ReturnType<typeof blocks>) {
  const update = captured(s.live, () => writeBlocks(fragment(s.live), schema, content));
  await h.persistence.journal.append(s.documentId, update, { origin: "system", seq: 0 });
}
async function read(s: Seed) {
  return coordinator.readDraft(s.draftId, async (doc) => blocks(doc));
}
function once(content: ReturnType<typeof blocks>, needle: string) {
  const count =
    content
      .map((b) => b.textContent)
      .join("\n")
      .split(needle).length - 1;
  assert.equal(count, 1, `${needle}: ${count} occurrences`);
}
async function reached(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Probe did not reach its interleaving latch")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const passed: string[] = [];
async function row(name: string, run: () => Promise<void>) {
  await run();
  passed.push(name);
  console.log(`PASS ${name}`);
}
try {
  await row("two-writers-50k-low-similarity-and-quote", async () => {
    const base = Array.from({ length: 100 }, (_, i) =>
      paragraph(Array.from({ length: 500 }, (_, j) => `old${i}word${j}`).join(" ")),
    );
    const s = await seed("r-50k", base);
    const first = clone(s.room),
      second = clone(s.room);
    const a = captured(first, () => textAt(first, 1).insert(7, " writerAlpha "));
    const b = captured(second, () => textAt(second, 2).insert(7, " writerBeta "));
    const rewritten = base.map((node, i) =>
      i === 1
        ? quote(node.textContent)
        : i === 2
          ? paragraph("A completely unrelated live replacement.")
          : node,
    );
    await live(s, rewritten);
    let release!: () => void, held!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const arrived = new Promise<void>((done) => {
      held = done;
    });
    const remove = setTestHook("draft.append.beforeCommit", async () => {
      held();
      await gate;
    });
    try {
      const rebase = pulls.flushLivePull(s.documentId);
      await reached(arrived);
      const frames = Promise.all([writer(s, a), writer(s, b)]);
      remove();
      release();
      await rebase;
      await frames;
    } finally {
      remove();
      release();
    }
    const result = await read(s);
    once(result, "writerAlpha");
    once(result, "writerBeta");
    console.log(JSON.stringify({ words: 50_000, lastAppends: h.appends.slice(-3) }));
  });
  await row("pending-writer-agent-on-wrapped-block-once", async () => {
    const s = await seed("r-pending");
    const w = clone(s.room);
    const a = clone(s.room);
    await writer(
      s,
      captured(w, () => textAt(w).insert(4, " writerPending")),
    );
    await agent(
      s,
      captured(a, () => textAt(a).insert(4, " agentPending")),
      a,
    );
    await live(s, [quote("Base words.")]);
    await pulls.flushLivePull(s.documentId);
    const result = await read(s);
    // A wrap is an attribute change, so the draft's typing lands in the one quoted block.
    assert.equal(result.length, 1);
    assert.equal(result[0]?.attrs.path, ">");
    once(result, "writerPending");
    once(result, "agentPending");
  });
  await row("late-typing-extends-one-paragraph-and-reconnect-is-contained", async () => {
    const s = await seed("r-late");
    const stale = clone(s.room);
    const first = captured(stale, () => textAt(stale).insert(4, "lateA"));
    await live(s, [quote("Base words.")]);
    await pulls.flushLivePull(s.documentId);
    assert.equal((await writer(s, first)).admitted, true);
    const second = captured(stale, () => textAt(stale).insert(9, "B"));
    await writer(s, second);
    const result = await read(s);
    // The quote kept the paragraph's element, so the late typing lands in the quoted block.
    assert.equal(result.length, 1);
    once(result, "lateAB");
    assert.equal(result[0]?.attrs.path, ">");
    assert.equal((await writer(s, Y.encodeStateAsUpdate(stale))).admitted, false);
  });
  await row("deletion-only-late-frame-advances-span-memory", async () => {
    const s = await seed("r-deletion-memory", [paragraph("ab")]);
    const stale = clone(s.room);
    const first = captured(stale, () => {
      textAt(stale).insert(1, "X");
      textAt(stale).insert(3, "Y");
    });
    await live(s, [rebuilt("ab")]);
    await pulls.flushLivePull(s.documentId);
    await writer(s, first);
    assert.equal((await read(s)).length, 3);
    await writer(
      s,
      captured(stale, () => textAt(stale).delete(2, 1)),
    );
    await writer(
      s,
      captured(stale, () => textAt(stale).insert(2, "Z")),
    );
    const result = await read(s);
    assert.equal(result.length, 2);
    once(result, "XZY");
  });
  await row("deferred-contained-observer-keeps-newer-recovery-spans", async () => {
    const s = await seed("r-memory-deferred", [paragraph("ab")]);
    const stale = clone(s.room);
    const first = captured(stale, () => {
      textAt(stale).insert(1, "X");
      textAt(stale).insert(3, "Y");
    });
    await live(s, [rebuilt("ab")]);
    await pulls.flushLivePull(s.documentId);
    await writer(s, first);
    const deletion = captured(stale, () => textAt(stale).delete(2, 1));
    let resume!: () => void, signal!: () => void;
    const observed = new Promise<void>((done) => {
      signal = done;
    });
    const released = new Promise<void>((done) => {
      resume = done;
    });
    const outer = runInRootDrizzleTransaction(h.db, async () => {
      await writer(s, deletion);
      signal();
      await released;
    });
    try {
      await reached(observed);
      await writer(
        s,
        captured(stale, () => textAt(stale).insert(2, "Z")),
      );
      resume();
      await outer;
      await writer(
        s,
        captured(stale, () => textAt(stale).insert(3, "W")),
      );
      const result = await read(s);
      assert.equal(result.length, 2);
      once(result, "XZWY");
    } finally {
      resume();
      await outer;
    }
  });
  await row("typing-the-deleter-never-saw-is-recovered-in-either-order", async () => {
    // The delete arrives first: the typing lands under a deleted block.
    const first = await seed("r-writer-delete");
    const stale = clone(first.room),
      other = clone(first.room);
    const typing = captured(stale, () => textAt(stale).insert(4, "recoveredLate"));
    await writer(
      first,
      captured(other, () => fragment(other).delete(0, 1)),
    );
    await writer(first, typing);
    once(await read(first), "recoveredLate");
    // The typing arrives first: the delete removes it without listing it.
    const second = await seed("r-writer-delete-after");
    const typist = clone(second.room),
      deleter = clone(second.room);
    await writer(
      second,
      captured(typist, () => textAt(typist).insert(4, "recoveredFirst")),
    );
    await writer(
      second,
      captured(deleter, () => fragment(deleter).delete(0, 1)),
    );
    once(await read(second), "recoveredFirst");
    // A deleter that saw the typing deletes it for good.
    const third = await seed("r-writer-delete-seen");
    const seen = clone(third.room);
    await writer(
      third,
      captured(seen, () => textAt(seen).insert(4, "seenThenDeleted")),
    );
    await writer(
      third,
      captured(seen, () => fragment(seen).delete(0, 1)),
    );
    assert.ok(!(await read(third)).some((b) => b.textContent.includes("seenThenDeleted")));
  });
  await row("effect-drops-after-live-matches-no-key", async () => {
    const s = await seed("r-effect");
    const w = clone(s.room);
    await writer(
      s,
      captured(w, () => textAt(w).insert(4, " change")),
    );
    await effect.flush();
    assert.equal((await h.store.readDraftAt(s.draftId))?.documentDraft.hasEffect, true);
    await live(s, [paragraph("Base change words.")]);
    await pulls.flushLivePull(s.documentId);
    await effect.flush();
    assert.equal((await h.store.readDraftAt(s.draftId))?.documentDraft.hasEffect, false);
  });
  await row("reconnect-with-unsent-typing-after-base-tombstones", async () => {
    const s = await seed("r-reconnect");
    const old = clone(s.room);
    await live(s, [rebuilt("Base words.")]);
    await pulls.flushLivePull(s.documentId);
    await coordinator.readDraft(s.draftId, async (doc) => {
      Y.applyUpdate(old, Y.encodeStateAsUpdate(doc));
    });
    const text = (fragment(old).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(text.length, " unsentReconnect");
    assert.equal((await writer(s, Y.encodeStateAsUpdate(old))).admitted, true);
    once(await read(s), "unsentReconnect");
  });
  await row("turn-inverse-fresh-seed-no-live-duplication", async () => {
    const s = await seed("r-inverse");
    const peer = clone(s.room);
    await agent(
      s,
      captured(peer, () => textAt(peer).insert(4, " agentInverse")),
      peer,
    );
    const inverse = createDrizzleTurnInverseService({
      fileAccess: createAllowAllFileAccess(),
      db: h.db,
      journal: h.persistence.journal,
      drafts: h.store,
      coordinator: liveCoordinator,
      draftCoordinator: coordinator,
      onDraftCommitted: (id) => effect.markDirty(id),
      resolveDocumentUri: async () => "probe.md",
      refreshDocument: async () => {},
      flushLivePull: (id) => pulls.flushLivePull(id),
      notices: { record: async () => {} },
      workProjection: h.projection,
      removals: createTestRemovalDeps(h.db).removals,
      treeLists: createTestRemovalDeps(h.db).treeLists,
    });
    const result = await runWithEditConfirmation(workGrant(h, s.workId), () =>
      inverse.modelInverse(
        {
          threadId: s.threadId,
          turnId: s.turnId,
          documentIds: [s.documentId],
          draftId: s.draftId,
          model: true,
        } as never,
        { command: "undo", file: "probe.md" },
      ),
    );
    assert.equal(result.status, "success");
    assert.deepEqual(
      (await read(s)).map((b) => b.textContent),
      ["Base words."],
    );
  });
  console.log(`${passed.length}/9 acceptance rows passed`);
} finally {
  effect.dispose();
  pulls.cancelScheduledPulls();
  for (const doc of docs) doc.destroy();
  await h.close();
  await scratch.drop();
}
