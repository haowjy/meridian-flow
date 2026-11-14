/** Apply API-core probes over a scratch Postgres and the production command/append adapters. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BranchId } from "@meridian/contracts";
import type {
  ApplyClick,
  ApplyClickAnswer,
  UnapplyClickAnswer,
} from "@meridian/contracts/branches";
import { projects, works } from "@meridian/database";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import {
  createDrizzleApplyClick,
  measureApplyAppend,
} from "../../../../apps/server/server/domains/collab/adapters/drizzle-apply-click.ts";
import { createDrizzleBranchDiscard } from "../../../../apps/server/server/domains/collab/adapters/drizzle-branch-discard.ts";
import { createDrizzleDocumentCommands } from "../../../../apps/server/server/domains/collab/adapters/drizzle-document-commands.ts";
import { createDraftClose } from "../../../../apps/server/server/domains/collab/adapters/drizzle-draft-close.ts";
import { createDrizzleDraftDispositionStore } from "../../../../apps/server/server/domains/collab/adapters/drizzle-draft-disposition.ts";
import { createDrizzleTreeHistory } from "../../../../apps/server/server/domains/collab/adapters/drizzle-tree-history.ts";
import { createDrizzleWorkBranchPendingStore } from "../../../../apps/server/server/domains/collab/adapters/drizzle-work-branch-pending.ts";
import { createApplyClickService } from "../../../../apps/server/server/domains/collab/domain/apply-click.ts";
import { createBranchReviewIdentity } from "../../../../apps/server/server/domains/collab/domain/branch-review-identity.ts";
import { createBranchReviewItems } from "../../../../apps/server/server/domains/collab/domain/branch-review-items.ts";
import type { CommandLookupKey } from "../../../../apps/server/server/domains/collab/domain/document-commands.ts";
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
import {
  handleApplyClickRequest,
  handleUnapplyClickRequest,
} from "../../../../apps/server/server/lib/branch-review-route.ts";
import { runInDrizzleTransaction } from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import { setTestHook } from "../../../../apps/server/server/shared/test-hooks.ts";
import { createTestDocumentRemoval } from "../../../../apps/server/server/test-support/document-removal.ts";
import { contentMerge } from "../../../../packages/agent-edit/src/content-merge/index.ts";
import {
  applySpanPatches,
  baseViewDelta,
  composeGroups,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readApplyRecord,
  readBlocks,
  writeBlocks,
} from "../../../../packages/agent-edit/src/diff/index.ts";
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
// Ids by position: the merge pairs blocks by id, so each block of a document needs its own.
const paragraph = (text: string, at = 0) =>
  schema.nodes.paragraph.create({ id: `p${at}` }, text ? schema.text(text) : undefined);
// A text starting with "+" is a block the writer made new (a split's second part): a new id. A text
// ending in "@2" is the block that had position 2 in the base, wherever it stands now.
const blocks = (texts: string[]) =>
  texts.map((text, at) => {
    const [, body, was] = /^(.*?)(?:@(\d+))?$/s.exec(text) ?? [];
    return body.startsWith("+")
      ? schema.nodes.paragraph.create({ id: `n${at}` }, schema.text(body.slice(1)))
      : paragraph(body, was === undefined ? at : Number(was));
  });
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
const commands = createDrizzleDocumentCommands(h.db);

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
    liveRoom: null,
  });
  liveSeed.destroy();
  const room = await h.coordinator.readDraft(snapshot.draftId, async (doc) => clone(doc, client++));
  const apiStore = createDrizzleApplyClick(h.db, {
    workProjection: h.projection,
    branches: h.branches,
    coordinator: h.coordinator,
    live: h.persistence.journal,
    liveCoordinator: {
      deliver: async () => {
        recovered++;
      },
    },
    catalog: { refreshSources: async () => "0" },
    arrivals: { settle: async () => 0 },
    removal: createTestDocumentRemoval(h.db),
    history: createDrizzleTreeHistory(h.db, h.persistence.journal),
    close: createDraftClose(),
    releaseObjects: async () => {},
    onCommitted: async () => {},
    merged: () => {},
    measured: (m) => measure.push(m),
  });
  const pending = createDrizzleWorkBranchPendingStore(h.db);
  const identity = createBranchReviewIdentity({
    branches: h.branches,
    reviewItems: createBranchReviewItems({
      tree: createTreeReader(h.db),
      drafts: pending.listBranchDraftMetadata,
      pendingThreadIds: pending.pendingThreadIds,
      treeActors: pending.listTreeActors,
    }),
  });
  const service = createApplyClickService({
    identity,
    commands,
    evidence: createDrizzleDraftDispositionStore(h.db),
    store: apiStore,
  });
  const routeServices = {
    projects: {
      findById: async (id: string) =>
        (await h.db.select().from(projects).where(eq(projects.id, id)))[0],
    },
    works: {
      findById: async (id: string) => (await h.db.select().from(works).where(eq(works.id, id)))[0],
    },
    fileAccess,
    documentSync: {
      draftReview: {
        applyClick: service.apply,
        unapplyClick: service.unapply,
        resolveItemByDocument: identity.resolveReviewItemByDocument,
        resolveItemInBranch: identity.resolveReviewItemInBranch,
        branchOwner: (branchId: BranchId) => h.branches.ownerOf(branchId),
        lookupCommand: (key: CommandLookupKey) => commands.lookup(key),
      },
      roomRemoval: async ({ documentId }: { documentId: string }) => {
        const removal = (await readRemovalRecords(h.db, [documentId])).get(documentId);
        return removal ? { documentId, removal } : null;
      },
    },
  } as never;
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
      return handleApplyClickRequest(routeServices, {
        userId: h.ids.user,
        projectId: h.ids.project,
        branchId: work.branchId,
        documentId: document.documentId,
        request: changedDigest ? { ...click.request, groupIds: ["changed-digest"] } : click.request,
      });
    },
    unapply(click: FrozenClick, commandId = randomUUID()): Promise<UnapplyClickAnswer> {
      return handleUnapplyClickRequest(routeServices, {
        userId: h.ids.user,
        projectId: h.ids.project,
        branchId: work.branchId,
        documentId: document.documentId,
        request: { commandId, applyCommandId: click.request.commandId },
      });
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
      // The ids an editor would keep: a block moved keeps its id, a block edited in place keeps its own.
      const current = readBlocks(doc.getXmlFragment("prosemirror"), schema);
      const used = new Set<string>();
      const claim = (id: unknown) => {
        if (typeof id !== "string" || used.has(id)) return undefined;
        used.add(id);
        return id;
      };
      const ids = texts.map((text) =>
        claim(current.find((b) => b.textContent === text && !used.has(b.attrs.id))?.attrs.id),
      );
      const next = texts.map((text, at) =>
        paragraph(text, 0).type.create(
          {
            id:
              ids[at] ?? claim(current[at]?.attrs.id) ?? `n${at}-${texts.length}-${Math.random()}`,
          },
          text ? schema.text(text) : undefined,
        ),
      );
      doc.transact(() => writeBlocks(doc.getXmlFragment("prosemirror"), schema, next));
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
          const merged = contentMerge(
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
        await h.raw`select count(*)::int as n from document_commands where id=${c.request.commandId}`
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
          await h.raw`select count(*)::int as n from document_commands where id in (${bad.request.commandId},${overlap.request.commandId})`
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
          await h.raw`select count(*)::int as n from document_commands where id=${c.request.commandId}`
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
        await h.raw`select count(*)::int as n from document_commands where id=${c.request.commandId}`
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
      releaseObjects: async () => {},
      workProjection: h.projection,
      branches: h.branches,
      close: createDraftClose(),
      removal: createTestDocumentRemoval(h.db),
      catalog: { refreshSources: async () => "0" },
    });
    await discard.discardLocked({
      kernel: { branchId: a.branchId, userId: h.ids.user, selection: { kind: "whole" } },
      command: h.discardCommand(a.branchId),
    });
    const branch = await h.projection.mutate({ works: [a.workId] }, () =>
      h.branches.ensureActiveLocked({
        owner: { kind: "work", workId: a.workId },
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
  const draftStatus = async (f: Awaited<ReturnType<typeof fixture>>) =>
    (await h.raw`select status from document_drafts where id=${f.draftId}`)[0].status;
  /** The click a writer sends knowing the document is deleted. */
  const restoring = (c: FrozenClick): FrozenClick => ({
    ...c,
    request: { ...c.request, restore: true },
  });
  await row("a document deleted live: its draft stays, Apply restores it then merges", async () => {
    const f = await fixture(["Base."], ["Changed."]);
    await deleteLive(f);
    assert.equal(await draftStatus(f), "active");
    // A click that did not know of the delete changes nothing, and its replay says so again.
    const unknowing = f.click();
    const asked = await f.send(unknowing);
    assert.deepEqual(asked, { status: "needs_restore", commandId: unknowing.request.commandId });
    assert.deepEqual(await f.send(unknowing), asked);
    assert.equal(await living(f), false);
    assert.equal(await draftStatus(f), "active");
    const c = restoring(f.click());
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
        result = await applied(f, restoring(f.click()));
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
  await row("Apply restores a deleted document beside a new document at its old path", async () => {
    const f = await fixture(["Base."], ["Changed."]);
    const [{ name, extension, folder_id: folderId }] =
      await h.raw`select name, extension, folder_id from documents where id=${f.documentId}`;
    await deleteLive(f);
    await h.raw`insert into documents (context_source_id, folder_id, name, extension)
      select context_source_id, ${folderId}, ${name}, ${extension} from documents where id=${f.documentId}`;
    const c = restoring(f.click());
    const applied = await f.send(c);
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    assert.equal(
      applied.status === "applied" && applied.applied[0]?.renamed?.path.endsWith(" (2)"),
      true,
      JSON.stringify(applied),
    );
    assert.equal(await living(f), true);
    f.close();
  });

  await row(
    "a deleted document's Apply reads its own state beside the branch's hidden creation",
    async () => {
      const f = await fixture(["Base."], ["Changed."]);
      // An unrelated creation the branch holds hidden: the branch's view lists it first.
      const created = await h.seedDocument(`apply-${client++}`, "Created.");
      await h.raw`update documents set hidden=true where id=${created.documentId}`;
      await recordCreated(h.db, { branchId: f.branchId, documentId: created.documentId });
      await deleteLive(f);
      const unknowing = f.click();
      assert.deepEqual(await f.send(unknowing), {
        status: "needs_restore",
        commandId: unknowing.request.commandId,
      });
      const result = await applied(f, restoring(f.click()));
      assert.equal(result.status === "applied" && result.restored, true, JSON.stringify(result));
      assert.equal(await living(f), true);
      assert.deepEqual(await f.liveText(), ["Changed."]);
      assert.equal(
        (await h.raw`select hidden from documents where id=${created.documentId}`)[0].hidden,
        true,
        "the other creation stays the branch's",
      );
      created.live.destroy();
      f.close();
    },
  );
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
  await row(
    "a delete after compilation overtakes the live grant; the click asks first",
    async () => {
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
        assert.deepEqual(answer, { status: "needs_restore", commandId: c.request.commandId });
        assert.equal(await living(f), false);
        assert.equal(await draftStatus(f), "active");
      } finally {
        remove();
        f.close();
      }
    },
  );
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

  await row("Un-Apply reverses intact groups and replays its durable result", async () => {
    const f = await fixture(["The cat sat."], ["The big cat sat."]);
    const click = f.click();
    await applied(f, click);
    const commandId = randomUUID();
    const answer = await f.unapply(click, commandId);
    assert.equal(answer.status, "unapplied", JSON.stringify(answer));
    if (answer.status === "unapplied") {
      assert.deepEqual(answer.reversedGroupIds, click.request.groupIds);
      assert.deepEqual(answer.skippedGroupIds, []);
    }
    assert.deepEqual(await f.liveText(), ["The cat sat."]);
    const durable = await f.durable();
    assert.deepEqual(readApplyRecord(durable), []);
    durable.destroy();
    assert.deepEqual(await f.unapply(click, commandId), answer);
    f.close();
  });
  await row("a click's groups chain: live ends at the draft, Un-Apply returns it", async () => {
    // A join and, far from it, a split: with block ids a join is an edit of the first block and the
    // removal of the second, a split an edit and a new block, so there are two groups to chain.
    const long = "Then the long quiet hours of the night passed slowly by";
    const f = await fixture(
      ["She turned away", "She waited by", long, "He opened the door"],
      ["She turned away She waited by", `${long}@2`, "He opened@3", "+the door"],
    );
    const click = f.click();
    assert.equal(click.request.groupIds.length, 2);
    await applied(f, click);
    assert.deepEqual(await f.liveText(), [
      "She turned away She waited by",
      long,
      "He opened",
      "the door",
    ]);
    const answer = await f.unapply(click);
    assert.equal(answer.status, "unapplied", JSON.stringify(answer));
    if (answer.status === "unapplied") assert.equal(answer.reversedGroupIds.length, 2);
    assert.deepEqual(await f.liveText(), [
      "She turned away",
      "She waited by",
      long,
      "He opened the door",
    ]);
    f.close();
  });
  await row("Un-Apply reverses an edited group around the writer's typing and an intact peer whole", async () => {
    const f = await fixture(
      ["The cat sat.", "The dog slept."],
      ["The big cat sat.", "The small dog slept."],
    );
    const click = f.click();
    assert.equal(click.request.groupIds.length, 2);
    await applied(f, click);
    // The writer's word inside the applied text stays; Un-Apply takes only the Apply's own words.
    await f.liveWrite(["The big very cat sat.", "The small dog slept."]);
    const answer = await f.unapply(click);
    assert.equal(answer.status, "unapplied", JSON.stringify(answer));
    if (answer.status === "unapplied") {
      assert.equal(answer.reversedGroupIds.length, 2);
      assert.equal(answer.skippedGroupIds.length, 0);
    }
    assert.deepEqual(await f.liveText(), ["The very cat sat.", "The dog slept."]);
    const durable = await f.durable();
    assert.equal(readApplyRecord(durable).length, 0);
    durable.destroy();
    f.close();
  });
  await row("Un-Apply removes a null-live receipt without reopening a diff", async () => {
    const f = await fixture(["The cat sat."], ["The big cat sat."]);
    const click = f.click();
    await f.liveWrite(["The big cat sat."]);
    await applied(f, click);
    const answer = await f.unapply(click);
    assert.equal(answer.status, "unapplied", JSON.stringify(answer));
    assert.deepEqual(await f.liveText(), ["The big cat sat."]);
    const durable = await f.durable();
    assert.deepEqual(readApplyRecord(durable), []);
    assert.deepEqual(
      readBlocks(durable.getXmlFragment(REVIEW_BASE_FRAGMENT), schema).map(
        (block) => block.textContent,
      ),
      ["The big cat sat."],
    );
    assert.deepEqual(
      readBlocks(durable.getXmlFragment("prosemirror"), schema).map((block) => block.textContent),
      ["The big cat sat."],
    );
    durable.destroy();
    f.close();
  });
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
      // Blocked on the lock, the click cannot finish until the release below, so a generous
      // limit tells "waited" from "slow" without depending on the runner's speed.
      await Promise.race([command, new Promise((r) => setTimeout(r, 10_000))]);
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
