/** Apply API-core probes over a scratch Postgres and the production command/append adapters. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ApplyClick, ApplyClickAnswer } from "@meridian/contracts/branches";
import { projects, works } from "@meridian/database";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import {
  createDrizzleApplyClick,
  measureApplyAppend,
} from "../../../../apps/server/server/domains/collab/adapters/drizzle-apply-click.ts";
import { createDrizzleBranchCommands } from "../../../../apps/server/server/domains/collab/adapters/drizzle-branch-commands.ts";
import { createDrizzleBranchDiscard } from "../../../../apps/server/server/domains/collab/adapters/drizzle-branch-discard.ts";
import { createDrizzleChangeTrailAggregateWriter } from "../../../../apps/server/server/domains/collab/adapters/drizzle-change-trail-aggregate.ts";
import { createDraftClose } from "../../../../apps/server/server/domains/collab/adapters/drizzle-draft-close.ts";
import { createDrizzleDraftDispositionStore } from "../../../../apps/server/server/domains/collab/adapters/drizzle-draft-disposition.ts";
import { createDrizzleWorkBranchPendingStore } from "../../../../apps/server/server/domains/collab/adapters/drizzle-work-branch-pending.ts";
import { createStaticDocumentLinkScopes } from "../../../../apps/server/server/domains/collab/adapters/in-memory/static-document-link-scopes.ts";
import { createApplyClickService } from "../../../../apps/server/server/domains/collab/domain/apply-click.ts";
import type { CommandLookupKey } from "../../../../apps/server/server/domains/collab/domain/branch-commands.ts";
import { createBranchReviewIdentity } from "../../../../apps/server/server/domains/collab/domain/branch-review-identity.ts";
import { createBranchReviewItems } from "../../../../apps/server/server/domains/collab/domain/branch-review-items.ts";
import { materializeDraftRead } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import { lockDocumentNamespaces } from "../../../../apps/server/server/domains/context/adapters/context-fs/document-locations.ts";
import { recordCreated } from "../../../../apps/server/server/domains/context/tree/branch-tree-store.ts";
import { acquireTreeScope } from "../../../../apps/server/server/domains/context/tree/mutation-scope.ts";
import { readRemovalRecords } from "../../../../apps/server/server/domains/context/tree/removal.ts";
import { createTreeReader } from "../../../../apps/server/server/domains/context/tree/tree-view.ts";
import {
  createDrizzleFileFacts,
  createFileAccess,
  createOwnerFileGrants,
} from "../../../../apps/server/server/domains/file-policy/index.ts";
import { handleApplyClickRequest } from "../../../../apps/server/server/lib/branch-review-route.ts";
import { runInDrizzleTransaction } from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import { setTestHook } from "../../../../apps/server/server/shared/test-hooks.ts";
import { createTestDocumentRemoval } from "../../../../apps/server/server/test-support/document-removal.ts";
import {
  applySpanPatches,
  baseViewDelta,
  composeGroups,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readApplyRecord,
  readBlocks,
  rebase,
  writeBlocks,
} from "../../../../packages/agent-edit/src/diff/index.ts";
import {
  createAgentEditCodecFactory,
  yProsemirrorModel,
} from "../../../../packages/agent-edit/src/integration.ts";
import { mdxCodec } from "../../../../packages/markup/src/index.ts";
import {
  createScratchDatabase,
  gate,
  independently,
  openHarness,
  Y,
} from "../drafts-lock-free/harness.mts";

type FrozenClick = {
  request: ApplyClick;
  optimistic: ReturnType<typeof readBlocks>;
  patched: ReturnType<typeof readBlocks>;
};
const schema = buildDocumentSchema();
const paragraph = (text: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const blocks = (texts: string[]) => texts.map(paragraph);
const clone = (doc: Y.Doc, id = Math.floor(Math.random() * 1e9) + 100) => {
  const out = new Y.Doc({ gc: false });
  Y.applyUpdate(out, Y.encodeStateAsUpdate(doc));
  out.clientID = id;
  return out;
};
const scratch = await createScratchDatabase();
const h = await openHarness(scratch.url, measureApplyAppend);
await h.raw`update context_sources set slug='manuscript' where id=${h.ids.source}`;
const reports: unknown[] = [];
let client = 1000;
let recovered = 0;
const measure: unknown[] = [];
const fileAccess = createFileAccess({
  facts: createDrizzleFileFacts(h.db, h.projection),
  grants: createOwnerFileGrants(),
  readAgentChain: async () => [],
});
const commands = createDrizzleBranchCommands(h.db);

async function fixture(
  baseText: string[],
  draftText: string[] = baseText,
  existing?: { documentId: string; live: Y.Doc },
  existingWork?: Awaited<ReturnType<typeof h.seedWork>>,
) {
  const work = existingWork ?? (await h.seedWork(`apply-${client++}`));
  const document = existing ?? (await h.seedDocument(`apply-${client++}`, baseText.join("\n\n")));
  // The old harness live helper writes one paragraph. Make the requested blocks through the journal.
  if (!existing) {
    const live = await h.liveDoc(document.documentId);
    let update: Uint8Array | undefined;
    live.on("update", (bytes) => {
      update = bytes;
    });
    live.transact(() => writeBlocks(live.getXmlFragment("prosemirror"), schema, blocks(baseText)));
    if (update)
      await h.persistence.journal.append(document.documentId, update, { origin: "system", seq: 0 });
    live.destroy();
  }
  const liveSeed = await h.liveDoc(document.documentId);
  const snapshot = await h.store.ensureDocumentDraft({
    documentId: document.documentId,
    branchId: work.branchId,
    liveDoc: liveSeed,
  });
  liveSeed.destroy();
  const room = await h.coordinator.readDraft(snapshot.draftId, async (doc) => clone(doc, client++));
  const apiStore = createDrizzleApplyClick(h.db, {
    workProjection: h.projection,
    coordinator: h.coordinator,
    live: h.persistence.journal,
    liveCoordinator: {
      deliver: async () => {
        recovered++;
      },
    },
    model: yProsemirrorModel(schema),
    codec: createAgentEditCodecFactory(mdxCodec({ schema })),
    links: createStaticDocumentLinkScopes(),
    trail: createDrizzleChangeTrailAggregateWriter(h.db),
    catalog: { refreshSources: async () => "0" },
    arrivals: { settle: async () => 0 },
    onCommitted: async () => {},
    measured: (m) => measure.push(m),
  });
  const pending = createDrizzleWorkBranchPendingStore(h.db);
  const identity = createBranchReviewIdentity({
    branches: h.branches,
    reviewItems: createBranchReviewItems({
      tree: createTreeReader(h.db),
      drafts: pending.listBranchDraftMetadata,
      pendingThreadIds: pending.pendingThreadIds,
      creators: pending.listCreators,
    }),
  });
  const service = createApplyClickService({
    identity,
    commands,
    evidence: createDrizzleDraftDispositionStore(h.db),
    store: apiStore,
  });
  const f = {
    ...work,
    ...document,
    draftId: snapshot.draftId,
    room,
    async type(texts: string[], agent = false, owner = work) {
      let update: Uint8Array | undefined;
      const capture = (bytes: Uint8Array) => {
        update = bytes;
      };
      room.on("update", capture);
      room.transact(() => writeBlocks(room.getXmlFragment("prosemirror"), schema, blocks(texts)));
      room.off("update", capture);
      if (update) {
        const base = await h.coordinator.loadBase(snapshot.draftId);
        const write = h.coordinator.prepareAppend(base, [
          {
            draftId: snapshot.draftId,
            source: agent ? "agent" : "writer",
            updateData: update,
            ...(agent
              ? {
                  wId: await h.persistence.journal.reserveWriteOrdinal(
                    document.documentId,
                    owner.threadId,
                  ),
                  threadId: owner.threadId,
                  turnId: owner.turnId,
                  toolCallId: randomUUID(),
                }
              : { actorUserId: h.ids.user }),
          },
        ]);
        try {
          await write.persist();
          write.transfer();
        } finally {
          write.dispose();
        }
      }
    },
    click(
      optimistic = readBlocks(room.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
      selected?: number[],
    ): FrozenClick {
      const projection = projectReview(
        diffBlocks(optimistic, readBlocks(room.getXmlFragment("prosemirror"), schema)),
      );
      const ids = (selected ?? projection.groups.map((_, i) => i)).map(
        (i) => projection.groups[i].id,
      );
      const request = {
        commandId: randomUUID(),
        draftId: snapshot.draftId,
        snapshot: Buffer.from(Y.encodeSnapshotV2(Y.snapshot(room))).toString("base64"),
        baseViewDelta: baseViewDelta(
          schema,
          readBlocks(room.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
          optimistic,
        ).map((patch) => ({ ...patch, blocks: patch.blocks.map((block) => block.toJSON()) })),
        groupIds: ids,
      };
      return {
        request,
        optimistic,
        patched: applySpanPatches(
          optimistic,
          composeGroups(schema, projection, ids, "apply"),
          "base",
        ),
      };
    },
    send(click: FrozenClick, changedDigest?: string): Promise<ApplyClickAnswer> {
      return handleApplyClickRequest(
        {
          projects: {
            findById: async (id: string) =>
              (await h.db.select().from(projects).where(eq(projects.id, id)))[0],
          },
          works: {
            findById: async (id: string) =>
              (await h.db.select().from(works).where(eq(works.id, id)))[0],
          },
          fileAccess,
          documentSync: {
            draftReview: {
              applyClick: service,
              resolveItemByDocument: identity.resolveReviewItemByDocument,
              lookupCommand: (key: CommandLookupKey) => commands.lookup(key),
            },
            roomRemoval: async ({ documentId }: { documentId: string }) => {
              const removal = (await readRemovalRecords(h.db, [documentId])).get(documentId);
              return removal ? { documentId, removal } : null;
            },
          },
        } as never,
        {
          userId: h.ids.user,
          projectId: h.ids.project,
          workId: work.workId,
          documentId: document.documentId,
          request: changedDigest
            ? { ...click.request, groupIds: ["changed-digest"] }
            : click.request,
        },
      );
    },
    async durable(): Promise<Y.Doc> {
      const read = await h.store.readDraftAt(snapshot.draftId);
      assert.ok(read);
      return materializeDraftRead(read);
    },
    async sync(): Promise<void> {
      const doc = await f.durable();
      Y.applyUpdate(room, Y.encodeStateAsUpdate(doc));
      doc.destroy();
    },
    async liveWrite(texts: string[]) {
      const doc = await h.liveDoc(document.documentId);
      let update: Uint8Array | undefined;
      doc.on("update", (bytes) => {
        update = bytes;
      });
      doc.transact(() => writeBlocks(doc.getXmlFragment("prosemirror"), schema, blocks(texts)));
      if (update)
        await h.persistence.journal.append(document.documentId, update, {
          origin: "system",
          seq: 0,
        });
      doc.destroy();
    },
    async rebase() {
      const live = await h.liveDoc(document.documentId);
      const upstream = readBlocks(live.getXmlFragment("prosemirror"), schema);
      live.destroy();
      const base = await h.coordinator.loadBase(snapshot.draftId);
      const write = h.coordinator.prepareAppend(base, [], {
        authorServerRows(prefix) {
          let update: Uint8Array | undefined;
          prefix.on("update", (bytes) => {
            update = bytes;
          });
          const reviewBase = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
          const prose = prefix.getXmlFragment("prosemirror");
          const merged = rebase(
            schema,
            readBlocks(reviewBase, schema),
            upstream,
            readBlocks(prose, schema),
          );
          prefix.transact(() => {
            writeBlocks(reviewBase, schema, upstream);
            writeBlocks(prose, schema, merged.blocks);
          });
          return update ? [update] : [];
        },
      });
      try {
        await write.persist();
        write.transfer();
      } finally {
        write.dispose();
      }
    },
    async liveText() {
      const doc = await h.liveDoc(document.documentId);
      try {
        return readBlocks(doc.getXmlFragment("prosemirror"), schema).map((b) => b.textContent);
      } finally {
        doc.destroy();
      }
    },
    close() {
      room.destroy();
      document.live.destroy();
    },
  };
  if (draftText.join("\0") !== baseText.join("\0")) await f.type(draftText);
  return f;
}
async function row(name: string, run: () => Promise<unknown>) {
  const result = await run();
  reports.push({ name, result: result ?? "passed" });
  console.log(JSON.stringify(reports.at(-1)));
}
async function applied(f: Awaited<ReturnType<typeof fixture>>, c = f.click()) {
  const result = await f.send(c);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result;
}
try {
  await row("frozen cut, post-click typing, atomic base and record, duplicate", async () => {
    const f = await fixture(["The cat sat."], ["The big cat sat."]);
    const c = f.click();
    await f.type(["The big black cat sat."]);
    await applied(f, c);
    assert.deepEqual(await f.liveText(), ["The big cat sat."]);
    const d = await f.durable();
    assert.equal(
      readBlocks(d.getXmlFragment(REVIEW_BASE_FRAGMENT), schema)[0].textContent,
      "The big cat sat.",
    );
    assert.equal(
      readBlocks(d.getXmlFragment("prosemirror"), schema)[0].textContent,
      "The big black cat sat.",
    );
    assert.equal(readApplyRecord(d)[0].commandId, c.request.commandId);
    d.destroy();
    await applied(f, c);
    assert.equal(
      (
        await h.raw`select count(*)::int as n from push_lineage where idempotency_key=${c.request.commandId}`
      )[0].n,
      1,
    );
    f.close();
  });
  await row(
    "unknown group and overlapping delta refuse without claim; landed digest conflict",
    async () => {
      const f = await fixture(["Base."], ["Changed."]);
      const bad = f.click();
      bad.request.groupIds = ["unknown"];
      assert.equal((await f.send(bad)).status, "refused");
      const overlap = f.click();
      overlap.request.baseViewDelta = [
        { base: { from: 0, to: 1 }, draft: { from: 0, to: 1 }, blocks: [paragraph("O").toJSON()] },
        { base: { from: 0, to: 1 }, draft: { from: 0, to: 1 }, blocks: [] },
      ];
      assert.equal((await f.send(overlap)).status, "refused");
      assert.equal(
        (
          await h.raw`select count(*)::int as n from branch_commands where id in (${bad.request.commandId},${overlap.request.commandId})`
        )[0].n,
        0,
      );
      const c = f.click();
      await applied(f, c);
      assert.equal((await f.send(c, "different")).status, "conflict");
      f.close();
    },
  );
  await row(
    "injected throw after live rolls back both halves, claim and delivery; retry once",
    async () => {
      const f = await fixture(["Base."], ["Changed."]);
      const c = f.click();
      const beforeRecover = recovered;
      const remove = setTestHook("apply.afterLive", async () => {
        throw new Error("probe rollback");
      });
      try {
        await assert.rejects(f.send(c), /probe rollback/);
      } finally {
        remove();
      }
      assert.deepEqual(await f.liveText(), ["Base."]);
      assert.equal(recovered, beforeRecover);
      assert.equal(
        (
          await h.raw`select count(*)::int as n from branch_commands where id=${c.request.commandId}`
        )[0].n,
        0,
      );
      const doc = await f.durable();
      assert.equal(readApplyRecord(doc).length, 0);
      doc.destroy();
      await applied(f, c);
      await applied(f, c);
      f.close();
    },
  );
  await row("duplicate race has one claim; paused original answers stored applied", async () => {
    const f = await fixture(["Base."], ["Changed."]);
    const c = f.click();
    const entered = gate(),
      release = gate();
    let once = true;
    const remove = setTestHook("apply.beforeBoundary", async () => {
      if (once) {
        once = false;
        entered.open();
        await release.wait;
      }
    });
    try {
      const first = independently(() => f.send(c));
      await entered.wait;
      await applied(f, c);
      release.open();
      assert.equal((await first).status, "applied");
    } finally {
      release.open();
      remove();
    }
    assert.equal(
      (
        await h.raw`select count(*)::int as n from push_lineage where idempotency_key=${c.request.commandId}`
      )[0].n,
      1,
    );
    f.close();
  });
  await row("big black then delete black, first refused, successor lands big", async () => {
    const f = await fixture(["The cat sat."], ["The big black cat sat."]);
    const first = f.click();
    await f.type(["The big cat sat."]);
    const second = f.click(first.patched);
    first.request.groupIds = ["bad"];
    assert.equal((await f.send(first)).status, "refused");
    await applied(f, second);
    assert.deepEqual(await f.liveText(), ["The big cat sat."]);
    f.close();
  });
  await row("another tab applies between capture and dispatch", async () => {
    const f = await fixture(["The cat sat."], ["The big cat sat."]);
    const first = f.click(),
      second = f.click();
    await applied(f, first);
    await applied(f, second);
    assert.deepEqual(await f.liveText(), ["The big cat sat."]);
    f.close();
  });
  await row("landed retry after close stays applied, fresh id closes", async () => {
    const f = await fixture(["Base."], ["Changed."]);
    const c = f.click();
    await applied(f, c);
    await h.raw`update document_drafts set status='closed',closed_cause='discarded' where id=${f.draftId}`;
    await applied(f, c);
    const next = f.click();
    next.request.commandId = randomUUID();
    assert.equal((await f.send(next)).status, "closed");
    f.close();
  });
  await row("delayed deletion click stays bound to discarded draft after replacement", async () => {
    const a = await fixture(["The big black cat sat."], ["The cat sat."]);
    const click = a.click();
    const discard = createDrizzleBranchDiscard(h.db, {
      workProjection: h.projection,
      branches: h.branches,
      close: createDraftClose(),
      removal: createTestDocumentRemoval(h.db),
      catalog: { refreshSources: async () => "0" },
    });
    await discard.discardLocked({
      workId: a.workId,
      kernel: { branchId: a.branchId, userId: h.ids.user, selection: { kind: "whole" } },
    });
    const branch = await h.projection.mutate({ works: [a.workId] }, () =>
      h.branches.ensureActiveLocked({
        workId: a.workId,
        projectId: h.ids.project,
        createdBy: h.ids.user,
        originThreadId: a.threadId,
      }),
    );
    const b = await fixture(
      ["The big black cat sat."],
      ["The cat sat."],
      { documentId: a.documentId, live: clone(a.live) },
      { ...a, branchId: branch.id },
    );
    assert.notEqual(a.draftId, b.draftId);
    assert.notEqual(a.branchId, b.branchId);
    const answer = await a.send(click);
    console.log("delayed replacement answer", answer.status, await a.liveText());
    assert.equal(answer.status, "closed");
    assert.deepEqual(await a.liveText(), ["The big black cat sat."]);
    a.close();
    b.close();
  });
  await row("two Works merge distinct changes into one live paragraph", async () => {
    const a = await fixture(["The cat sat."], ["A cat sat."]);
    const b = await fixture(["The cat sat."], ["The cat slept."], {
      documentId: a.documentId,
      live: clone(a.live),
    });
    await Promise.all([applied(a), applied(b)]);
    assert.deepEqual(await a.liveText(), ["A cat slept."]);
    a.close();
    b.close();
  });
  await row("500+ frames and 40 keys/s beside a pending click", async () => {
    const f = await fixture(["The cat sat."], ["The big cat sat."]);
    const c = f.click();
    const entered = gate(),
      release = gate();
    const remove = setTestHook("apply.beforeBoundary", async () => {
      entered.open();
      await release.wait;
    });
    const pending = f.send(c);
    await entered.wait;
    const typingStart = performance.now();
    const keyTimes: number[] = [];
    for (let i = 0; i < 520; i++) {
      if (i < 40) {
        const wait = typingStart + i * 25 - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        keyTimes.push(performance.now());
      }
      await f.type([`The big cat sat. ${"x".repeat(i + 1)}`]);
    }
    release.open();
    remove();
    assert.equal((await pending).status, "applied");
    assert.deepEqual(await f.liveText(), ["The big cat sat."]);
    const doc = await f.durable();
    assert.match(readBlocks(doc.getXmlFragment("prosemirror"), schema)[0].textContent, /x{520}/);
    const rate = ((keyTimes.length - 1) * 1000) / (keyTimes[keyTimes.length - 1] - keyTimes[0]);
    assert.ok(rate >= 35, `Only ${rate} keys/s`);
    console.log(JSON.stringify({ typingKeysPerSecond: rate }));
    doc.destroy();
    f.close();
  });

  await row(
    "rebase in another chapter gap preserves live; rebase inside click reports overrode",
    async () => {
      const f = await fixture(
        ["One cat.", "Two birds.", "Three dogs."],
        ["One big cat.", "Two birds.", "Three dogs."],
      );
      const c = f.click();
      await f.liveWrite(["One cat.", "Two birds.", "Three wolves."]);
      await f.rebase();
      await applied(f, c);
      assert.deepEqual(await f.liveText(), ["One big cat.", "Two birds.", "Three wolves."]);
      f.close();
      const g = await fixture(["The cat sat."], ["The dog sat."]);
      const d = g.click();
      await g.liveWrite(["The wolf sat."]);
      await g.rebase();
      const result = await applied(g, d);
      assert.ok((result.overrode ?? 0) > 0, JSON.stringify(result));
      assert.deepEqual(await g.liveText(), ["The dog sat."]);
      await g.rebase();
      const state = await g.durable();
      assert.deepEqual(
        readBlocks(state.getXmlFragment(REVIEW_BASE_FRAGMENT), schema).map((b) => b.textContent),
        await g.liveText(),
      );
      state.destroy();
      g.close();
    },
  );
  await row("live paragraph move rebased before hold follows clicked prose", async () => {
    const f = await fixture(
      ["One cat.", "Two birds.", "Three dogs."],
      ["One big cat.", "Two birds.", "Three dogs."],
    );
    const c = f.click();
    await f.liveWrite(["Two birds.", "Three dogs.", "One cat."]);
    await f.rebase();
    await applied(f, c);
    assert.deepEqual(await f.liveText(), ["Two birds.", "Three dogs.", "One big cat."]);
    f.close();
  });
  await row("three identical paragraphs, second clicked while first pending", async () => {
    const f = await fixture(
      ["Cat.", "Divider one.", "Cat.", "Divider two.", "Cat."],
      ["Big cat.", "Divider one.", "Big cat.", "Divider two.", "Big cat."],
    );
    const first = f.click(undefined, [0]);
    const second = f.click(first.patched, [0]);
    await applied(f, first);
    await applied(f, second);
    assert.deepEqual(await f.liveText(), [
      "Big cat.",
      "Divider one.",
      "Big cat.",
      "Divider two.",
      "Cat.",
    ]);
    f.close();
  });
  await row("typing beside pending click gets its own frozen click", async () => {
    const f = await fixture(["The cat sat."], ["The big cat sat."]);
    const first = f.click();
    await f.type(["The big black cat sat."]);
    const second = f.click(first.patched);
    await applied(f, first);
    await applied(f, second);
    assert.deepEqual(await f.liveText(), ["The big black cat sat."]);
    f.close();
  });
  await row(
    "live wrote then deleted clicked text, deletion rebased before or after hold",
    async () => {
      for (const before of [true, false]) {
        const f = await fixture(["The cat sat."], ["The big cat sat."]);
        const first = f.click();
        await f.type(["The big cat slept."]);
        const second = f.click(first.patched);
        await f.liveWrite(["The big cat sat."]);
        await f.rebase();
        await f.liveWrite(["The cat sat."]);
        if (before) await f.rebase();
        await applied(f, first);
        if (!before) await f.rebase();
        await applied(f, second);
        assert.deepEqual(await f.liveText(), ["The big cat slept."]);
        const state = await f.durable();
        assert.deepEqual(
          readBlocks(state.getXmlFragment(REVIEW_BASE_FRAGMENT), schema).map((b) => b.textContent),
          ["The big cat slept."],
        );
        state.destroy();
        f.close();
      }
    },
  );
  await row("three click chain, first refused; two later clicks in one paragraph", async () => {
    const f = await fixture(["The cat sat."], ["The big black cat sat."]);
    const a = f.click();
    await f.type(["The big cat sat."]);
    const b = f.click(a.patched);
    await f.type(["The big cat slept."]);
    const c = f.click(b.patched);
    a.request.groupIds = ["unknown"];
    assert.equal((await f.send(a)).status, "refused");
    await applied(f, b);
    await applied(f, c);
    assert.deepEqual(await f.liveText(), ["The big cat slept."]);
    f.close();
  });
  await row("unknown clicked key refuses unsynced until acknowledged", async () => {
    const f = await fixture(["The cat sat."]);
    let update: Uint8Array | undefined;
    const capture = (bytes: Uint8Array) => {
      update = bytes;
    };
    f.room.on("update", capture);
    f.room.transact(() =>
      writeBlocks(f.room.getXmlFragment("prosemirror"), schema, blocks(["The big cat sat."])),
    );
    f.room.off("update", capture);
    const c = f.click();
    assert.deepEqual(await f.send(c), {
      status: "refused",
      reason: "unsynced",
      commandId: c.request.commandId,
    });
    assert.ok(update);
    const base = await h.coordinator.loadBase(f.draftId);
    const write = h.coordinator.prepareAppend(base, [
      {
        draftId: f.draftId,
        source: "writer",
        updateData: update,
        actorUserId: h.ids.user,
      },
    ]);
    try {
      await write.persist();
      write.transfer();
    } finally {
      write.dispose();
    }
    await applied(f, c);
    f.close();
  });
  /** Deletes the fixture's document live, as the tree's delete does, in its own transaction. */
  async function deleteLive(f: Awaited<ReturnType<typeof fixture>>) {
    await runInDrizzleTransaction(h.db, async () => {
      await acquireTreeScope(h.db, { documentIds: [f.documentId] });
      await createTestDocumentRemoval(h.db).remove({
        documentIds: [f.documentId],
        reason: "deleted",
        userId: h.ids.user,
      });
    });
  }
  const living = async (f: Awaited<ReturnType<typeof fixture>>) =>
    (await h.raw`select deleted_at is null as living from documents where id=${f.documentId}`)[0]
      .living;
  await row("a document deleted live: its draft stays, Apply restores it then merges", async () => {
    const f = await fixture(["Base."], ["Changed."]);
    await deleteLive(f);
    assert.equal(
      (await h.raw`select status from document_drafts where id=${f.draftId}`)[0].status,
      "active",
    );
    const c = f.click();
    const result = await applied(f, c);
    assert.equal(result.status === "applied" && result.restored, true, JSON.stringify(result));
    assert.equal(await living(f), true);
    assert.deepEqual(await f.liveText(), ["Changed."]);
    assert.equal(
      (await h.raw`select deletion_reason from documents where id=${f.documentId}`)[0]
        .deletion_reason,
      null,
    );
    // The replay answers the stored result, restore included.
    assert.deepEqual(await f.send(c), result);
    f.close();
  });
  await row(
    "a delete between Apply's scope guess and its lock retries namespace-first",
    async () => {
      const f = await fixture(["Base."], ["Changed."]);
      let raced = 0;
      const remove = setTestHook("apply.afterScopeGuess", async () => {
        if (raced++ === 0) await independently(() => deleteLive(f));
      });
      let result: ApplyClickAnswer;
      try {
        result = await applied(f);
      } finally {
        remove();
      }
      assert.equal(raced, 2, "one guess saw it living, the retry saw it deleted");
      assert.equal(result.status === "applied" && result.restored, true, JSON.stringify(result));
      assert.equal(await living(f), true);
      assert.deepEqual(await f.liveText(), ["Changed."]);
      f.close();
    },
  );
  await row("Apply holds a deleted document whose path a new document took", async () => {
    const f = await fixture(["Base."], ["Changed."]);
    const [{ name, extension, folder_id: folderId }] =
      await h.raw`select name, extension, folder_id from documents where id=${f.documentId}`;
    await deleteLive(f);
    await h.raw`insert into documents (context_source_id, folder_id, name, extension)
      select context_source_id, ${folderId}, ${name}, ${extension} from documents where id=${f.documentId}`;
    const c = f.click();
    assert.deepEqual(await f.send(c), {
      status: "refused",
      reason: "forbidden",
      commandId: c.request.commandId,
    });
    assert.equal(await living(f), false);
    f.close();
  });

  await row("hidden creation reveals inside Apply without replacing identity", async () => {
    const f = await fixture([""], ["Created content."]);
    await h.raw`update documents set hidden=true where id=${f.documentId}`;
    await recordCreated(h.db, { branchId: f.branchId, documentId: f.documentId });
    const c = f.click();
    await applied(f, c);
    assert.equal(
      (await h.raw`select hidden from documents where id=${f.documentId}`)[0].hidden,
      false,
    );
    assert.equal(
      (
        await h.raw`select count(*)::int as n from branch_tree_changes where branch_id=${f.branchId} and node_id=${f.documentId}`
      )[0].n,
      0,
    );
    assert.deepEqual(await f.liveText(), ["Created content."]);
    f.close();
  });
  await row(
    "AI membership writes committed trail navigation and explicit owner signals",
    async () => {
      const f = await fixture(["Base."]);
      await f.type(["Changed."], true);
      const c = f.click();
      await h.raw`delete from change_trail_dirty_log where thread_id=${f.threadId}`;
      await applied(f, c);
      const rows =
        await h.raw`select d.changes from change_trail_document_details d join change_trail_shells s on s.id=d.trail_id where s.thread_id=${f.threadId}`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].changes.length, 1);
      assert.match(rows[0].changes[0].beforeText, /Base/);
      assert.match(rows[0].changes[0].afterTextAtReceipt, /Changed/);
      assert.ok(rows[0].changes[0].navigation);
      assert.ok(
        (
          await h.raw`select 1 from change_trail_dirty_log where thread_id=${f.threadId} and turn_id=${f.turnId}`
        ).length,
      );
      f.close();
    },
  );

  for (const mode of [
    "independent",
    "live move",
    "draft move",
    "shared paragraph",
    "deletion",
  ] as const) {
    await row(`multi-author correspondence: ${mode}`, async () => {
      const original = [
        "First old words stay here.",
        "Second paragraph keeps all these old words staying over there.",
        "Last unchanged paragraph remains.",
      ];
      const f = await fixture(original);
      const other = await h.seedWork(`other-author-${client++}`);
      const first = "First AI words stay here.";
      const second =
        mode === "shared paragraph"
          ? "First AI words shine here."
          : "Second paragraph keeps all these AI words staying over there.";
      await f.type(
        mode === "draft move"
          ? [original[1], first, original[2]]
          : [first, original[1], original[2]],
        true,
      );
      f.room.clientID = client++;
      await f.type(
        mode === "shared paragraph"
          ? [second, original[1], original[2]]
          : mode === "draft move"
            ? [second, first, original[2]]
            : mode === "deletion"
              ? [first, original[2]]
              : [first, second, original[2]],
        true,
        other,
      );
      const c = f.click();
      if (mode === "live move") await f.liveWrite([original[1], original[0], original[2]]);
      await applied(f, c);
      for (const [owner, expected, forbidden] of mode === "shared paragraph"
        ? ([
            [f, second, original[1]],
            [other, second, original[1]],
          ] as const)
        : ([
            [f, first, "Second"],
            [other, mode === "deletion" ? original[1] : second, "First"],
          ] as const)) {
        const rows =
          await h.raw`select d.changes from change_trail_document_details d join change_trail_shells s on s.id=d.trail_id where s.thread_id=${owner.threadId} and s.turn_id=${owner.turnId}`;
        assert.equal(rows.length, 1);
        const changes = rows[0].changes as {
          beforeText: string | null;
          afterTextAtReceipt: string | null;
          navigation: unknown;
        }[];
        assert.equal(
          changes.length,
          mode === "draft move" && owner === f ? 2 : 1,
          JSON.stringify(changes),
        );
        const text = changes
          .map((change) => `${change.beforeText ?? ""} ${change.afterTextAtReceipt ?? ""}`)
          .join(" ");
        assert.ok(text.includes(expected), text);
        assert.ok(!text.includes(forbidden), text);
        assert.ok(changes.every((change) => change.navigation));
      }
      f.close();
    });
  }

  await row("multi-author unrelated replacement retains deleted-block ownership", async () => {
    const original = [
      "Alpha orchard blooms.",
      "Beta ocean roars.",
      "An unchanged spacer separates these authors completely.",
      "Third paragraph keeps all these old words standing over there.",
    ];
    const f = await fixture(original);
    const other = await h.seedWork(`replacement-author-${client++}`);
    const replacement = "New mountains shine.";
    await f.type([replacement, original[2], original[3]], true);
    f.room.clientID = client++;
    await f.type([replacement, original[2], original[3].replace("old", "AI")], true, other);
    await applied(f, f.click());
    for (const owner of [f, other]) {
      const rows =
        await h.raw`select d.changes from change_trail_document_details d join change_trail_shells s on s.id=d.trail_id where s.thread_id=${owner.threadId} and s.turn_id=${owner.turnId}`;
      assert.equal(rows.length, 1);
      const changes = rows[0].changes as {
        beforeText: string | null;
        afterTextAtReceipt: string | null;
        navigation: unknown;
      }[];
      const text = changes
        .map((change) => `${change.beforeText ?? ""} ${change.afterTextAtReceipt ?? ""}`)
        .join(" ");
      if (owner === f) {
        assert.ok(
          text.includes(original[0]) && text.includes(original[1]) && text.includes(replacement),
          text,
        );
        assert.ok(!text.includes("Third"), text);
      } else {
        assert.ok(text.includes("Third") && text.includes("AI"), text);
        assert.ok(!/Alpha|Beta|New mountains/.test(text), text);
      }
      assert.ok(changes.every((change) => change.navigation));
    }
    f.close();
  });

  await row(
    "paused before compile, retry applies then closes; original returns stored applied",
    async () => {
      const f = await fixture(["Base."], ["Changed."]);
      const c = f.click();
      const entered = gate(),
        release = gate();
      let once = true;
      const remove = setTestHook("apply.beforeCompile", async () => {
        if (once) {
          once = false;
          entered.open();
          await release.wait;
        }
      });
      try {
        const original = f.send(c);
        await entered.wait;
        await applied(f, c);
        await h.raw`update document_drafts set status='closed',closed_cause='discarded' where id=${f.draftId}`;
        await h.raw`update branches set status='closed',closed_at=now() where id=${f.branchId}`;
        release.open();
        assert.equal((await original).status, "applied");
      } finally {
        release.open();
        remove();
        f.close();
      }
    },
  );
  await row("a delete after compilation overtakes the live grant; the click restores", async () => {
    const f = await fixture(["Base."], ["Changed."]);
    const c = f.click();
    let once = true;
    const remove = setTestHook("apply.beforeBoundary", async () => {
      if (once) {
        once = false;
        await h.projection.mutate({ works: [f.workId] }, async () => {
          await acquireTreeScope(h.db, { documentIds: [f.documentId] });
          await createTestDocumentRemoval(h.db).remove({
            documentIds: [f.documentId],
            reason: "deleted",
            userId: h.ids.user,
          });
        });
      }
    });
    try {
      const answer = await f.send(c);
      assert.equal(answer.status === "applied" && answer.restored, true, JSON.stringify(answer));
      assert.deepEqual(await f.liveText(), ["Changed."]);
    } finally {
      remove();
      f.close();
    }
  });
  await row(
    "archived or deleted Work refuses fresh id but never replaces landed result",
    async () => {
      const f = await fixture(["Base."], ["Changed."]);
      const c = f.click();
      await applied(f, c);
      await h.raw`update works set archived_at=now() where id=${f.workId}`;
      await applied(f, c);
      const archived = f.click();
      assert.deepEqual(await f.send(archived), {
        status: "refused",
        commandId: archived.request.commandId,
        reason: "work_archived",
      });
      await h.raw`update works set deleted_at=now(),archived_at=null where id=${f.workId}`;
      await applied(f, c);
      const deleted = f.click();
      assert.deepEqual(await f.send(deleted), {
        status: "refused",
        commandId: deleted.request.commandId,
        reason: "work_deleted",
      });
      f.close();
    },
  );
  await row(
    "big black then delete black both land, disjoint refused predecessor stays out",
    async () => {
      const f = await fixture(["The cat sat."], ["The big black cat sat."]);
      const a = f.click();
      await f.type(["The big cat sat."]);
      const b = f.click(a.patched);
      await applied(f, a);
      await applied(f, b);
      assert.deepEqual(await f.liveText(), ["The big cat sat."]);
      f.close();
      const g = await fixture(["Cat.", "Divider.", "Dog."], ["Big cat.", "Divider.", "Dog."]);
      const first = g.click();
      await g.type(["Big cat.", "Divider.", "Small dog."]);
      const second = g.click(first.patched);
      first.request.groupIds = ["unknown"];
      assert.equal((await g.send(first)).status, "refused");
      await applied(g, second);
      assert.deepEqual(await g.liveText(), ["Cat.", "Divider.", "Small dog."]);
      g.close();
    },
  );

  await row("ordinary text Apply does not take the tree namespace", async () => {
    const f = await fixture(["Base."], ["Changed."]);
    const entered = gate(),
      release = gate();
    const holder = independently(() =>
      runInDrizzleTransaction(h.db, async () => {
        await lockDocumentNamespaces(h.db, [f.documentId]);
        entered.open();
        await release.wait;
      }),
    );
    await entered.wait;
    let completed = false;
    const command = f.send(f.click()).then((result) => {
      completed = true;
      return result;
    });
    try {
      await Promise.race([command, new Promise((r) => setTimeout(r, 500))]);
      const beforeRelease = completed;
      release.open();
      await holder;
      assert.equal((await command).status, "applied");
      assert.ok(beforeRelease, "text Apply waited on an unrelated tree namespace");
    } finally {
      release.open();
      await holder;
      await command.catch(() => {});
      f.close();
    }
  });
  console.log(JSON.stringify({ summary: "passed", rows: reports.length, measurements: measure }));
} finally {
  await h.close();
  await scratch.drop();
}
