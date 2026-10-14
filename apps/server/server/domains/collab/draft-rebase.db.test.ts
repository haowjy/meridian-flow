/** The content rebase, the certified live cut, fresh seeding and review_base admission, on real Postgres. */
import {
  DRAFT_SERVER_CLIENT_ID,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
} from "@meridian/agent-edit/diff";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import type { Node as PMNode } from "prosemirror-model";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInRootDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { createLiveCutReader } from "./adapters/drizzle-live-cut.js";
import { createDraftRebase, type DraftRebase, draftSchema } from "./domain/draft-rebase.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
  resetDatabase,
  schema,
  USER_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const pm = draftSchema;
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

const paragraphs = (...texts: string[]): PMNode[] =>
  texts.map((text) => pm.node("paragraph", null, [pm.text(text)]));
const textOf = (blocks: readonly PMNode[]) => blocks.map((block) => block.textContent);

async function setup() {
  const fixture = await inverseFixture(db);
  const { view } = fixture;
  const draftRow = async () => {
    const [row] = await db
      .select()
      .from(schema.documentBranches)
      .where(
        and(
          eq(schema.documentBranches.documentId, ALPHA_ID),
          eq(schema.documentBranches.kind, "work_draft"),
        ),
      );
    if (!row) throw new Error("no draft");
    return row;
  };
  const decode = (state: Uint8Array) => {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, state);
    return doc;
  };
  const read = async () => {
    const row = await draftRow();
    const doc = decode(row.state);
    try {
      return {
        row,
        draft: textOf(readBlocks(doc.getXmlFragment("prosemirror"), pm)),
        base: textOf(readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), pm)),
      };
    } finally {
      doc.destroy();
    }
  };
  /** The pull path's own step: the branch lease, then one transaction around the catch-up. */
  const catchUp = async (rebase: DraftRebase) => {
    const row = await draftRow();
    return view.branchCoordinator.withLeases([row.id], (lease) =>
      runInRootDrizzleTransaction(db, () => rebase.catchUp(lease, row.id)),
    );
  };
  const rebaseOn = (cut: () => { seq: number; blocks: PMNode[] }) =>
    createDraftRebase({
      branchCoordinator: view.branchCoordinator,
      liveCut: {
        read: async () => ({
          revision: { authorityId: "live", authorityGeneration: "1", ...cut() },
          blocks: cut().blocks,
        }),
      },
      blockingApplySettlement: view.branchStore.blockingApplySettlement,
    });
  const rebaseTo = async (seq: number, blocks: PMNode[]) =>
    catchUp(rebaseOn(() => ({ seq, blocks })));
  /** A browser update authored from `state`, committed through the writer path against `room`. */
  const writerUpdate = async (
    doc: Y.Doc,
    room: Y.Doc,
    edit: (doc: Y.Doc) => void,
    branchId: string,
  ) => {
    doc.clientID = allocateDocumentClient(doc);
    const updateData = Y.mergeUpdates(captureMutationUpdates(doc, () => edit(doc)));
    Y.applyUpdate(room, updateData);
    return view.branchCoordinator.commitWriterUpdate({
      branchId,
      updateData,
      actorUserId: USER_ID,
      roomDocument: room,
    });
  };
  return { ...fixture, draftRow, decode, read, catchUp, rebaseTo, writerUpdate };
}

const firstText = (doc: Y.Doc, fragment: string) =>
  (doc.getXmlFragment(fragment).get(0) as Y.XmlElement).get(0) as Y.XmlText;

describe("content rebase of a Work draft", () => {
  it("writes prosemirror, review_base, base_revision and has_effect in one CAS, and ignores an old revision", async () => {
    const { harness, view, draftRow, decode, read, rebaseTo, writerUpdate } = await setup();
    try {
      const before = await draftRow();
      const doc = decode(before.state);
      await writerUpdate(
        doc,
        decode(before.state),
        (d) => firstText(d, "prosemirror").insert(0, "Own "),
        before.id,
      );

      const seq = (before.baseRevision?.seq ?? 0) + 5;
      const casCalls: unknown[] = [];
      const original = view.branchStore.updateBranchSnapshot;
      view.branchStore.updateBranchSnapshot = async (input) => {
        casCalls.push({ baseRevision: input.baseRevision, effect: input.effect });
        return original(input);
      };
      const outcome = await rebaseTo(seq, paragraphs("Alpha Beta.", "Blue.", "Green."));
      view.branchStore.updateBranchSnapshot = original;
      expect(outcome).toMatchObject({ kind: "rebased" });
      expect(casCalls).toEqual([
        {
          baseRevision: expect.objectContaining({ seq }),
          effect: { kind: "text", hasEffect: true },
        },
      ]);
      const after = await read();
      expect(after.base).toEqual(["Alpha Beta.", "Blue.", "Green."]);
      expect(after.draft).toEqual(["Own Alpha Beta.", "Blue.", "Green."]);
      expect(after.row.hasEffect).toBe(true);

      for (const stale of [seq, seq - 1]) {
        expect(await rebaseTo(stale, paragraphs("Late."))).toEqual({
          kind: "noop",
          reason: "current",
        });
      }
      expect((await draftRow()).state).toEqual(after.row.state);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("refuses a branch with no base instead of reading the missing base as empty", async () => {
    const { harness, draftRow, rebaseTo } = await setup();
    try {
      await db
        .update(schema.documentBranches)
        .set({ baseRevision: null })
        .where(eq(schema.documentBranches.id, (await draftRow()).id));
      const before = await draftRow();
      expect(await rebaseTo(5, paragraphs("Live."))).toEqual({
        kind: "failed",
        reason: "base_uninitialized",
      });
      expect((await draftRow()).state).toEqual(before.state);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("rejects a client update that creates, edits or deletes anything under review_base", async () => {
    const { harness, draftRow, decode, writerUpdate } = await setup();
    try {
      const row = await draftRow();
      const attempts: Array<[string, (doc: Y.Doc) => void]> = [
        ["edits base text", (d) => firstText(d, REVIEW_BASE_FRAGMENT).insert(0, "forged ")],
        [
          "creates a base paragraph",
          (d) => d.getXmlFragment(REVIEW_BASE_FRAGMENT).insert(0, [new Y.XmlElement("paragraph")]),
        ],
        ["deletes a base paragraph", (d) => d.getXmlFragment(REVIEW_BASE_FRAGMENT).delete(0, 1)],
      ];
      for (const [name, edit] of attempts) {
        const doc = decode(row.state);
        await expect(writerUpdate(doc, decode(row.state), edit, row.id), name).rejects.toThrow(
          /server-owned state/,
        );
      }
      const typing = decode(row.state);
      await expect(
        writerUpdate(
          typing,
          decode(row.state),
          (d) => firstText(d, "prosemirror").insert(0, "ok "),
          row.id,
        ),
      ).resolves.toMatchObject({ admitted: true });
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("admits a reconnect that repeats the server's own base tombstones, and still refuses a live base delete", async () => {
    const { harness, draftRow, decode, rebaseTo, writerUpdate } = await setup();
    try {
      const start = (await draftRow()).baseRevision?.seq ?? 0;
      // A rebase that rewrites the base leaves server tombstones in review_base.
      await rebaseTo(start + 1, paragraphs("Rewritten by live."));
      const rebased = await draftRow();
      // The browser's cumulative state carries those tombstones back on reconnect, with its own typing.
      const room = decode(rebased.state);
      const reconnecting = decode(rebased.state);
      await expect(
        writerUpdate(
          reconnecting,
          room,
          (d) => firstText(d, "prosemirror").insert(0, "typed "),
          rebased.id,
        ),
      ).resolves.toMatchObject({ admitted: true });
      const deletion = decode(rebased.state);
      await expect(
        writerUpdate(
          deletion,
          decode(rebased.state),
          (d) => d.getXmlFragment(REVIEW_BASE_FRAGMENT).delete(0, 1),
          rebased.id,
        ),
      ).rejects.toThrow(/server-owned state/);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("keeps a peer's mid-paragraph deletion when the rebase rewrites the paragraph's ends", async () => {
    const { harness, draftRow, decode, read, rebaseTo, writerUpdate } = await setup();
    try {
      const start = (await draftRow()).baseRevision?.seq ?? 0;
      await rebaseTo(start + 1, paragraphs("aaa bbb ccc ddd eee"));
      const seeded = await draftRow();
      // The peer authors its deletion against the state before the next rebase.
      const peer = decode(seeded.state);
      await rebaseTo(start + 2, paragraphs("AAA bbb ccc ddd EEE"));
      const rebased = await draftRow();
      const room = decode(rebased.state);
      await writerUpdate(peer, room, (d) => firstText(d, "prosemirror").delete(8, 4), rebased.id);
      expect((await read()).draft).toEqual(["AAA bbb ddd EEE"]);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("seeds a new draft as the server client alone, sharing no ancestry with live", async () => {
    const { harness, view, draftRow, read } = await setup();
    try {
      const live = await view.liveCoordinator.withDocument(ALPHA_ID, async (doc) => [
        ...Y.decodeStateVector(Y.encodeStateVector(doc)).keys(),
      ]);
      const clients = [
        ...Y.decodeStateVector(Y.encodeStateVectorFromUpdate((await draftRow()).state)).keys(),
      ];
      expect(clients).toEqual([DRAFT_SERVER_CLIENT_ID]);
      for (const client of live) expect(clients).not.toContain(client);
      const { draft, base } = await read();
      expect(base).toEqual(draft);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("catches up on the journal's own cut and labels the base with the revision it read", async () => {
    const { harness, view, draftRow, read, catchUp } = await setup();
    try {
      await db
        .update(schema.documentBranches)
        .set({ baseRevision: { authorityId: "unknown", authorityGeneration: "0", seq: 0 } })
        .where(eq(schema.documentBranches.id, (await draftRow()).id));
      const rebase = createDraftRebase({
        branchCoordinator: view.branchCoordinator,
        liveCut: createLiveCutReader(view.persistence.journal),
        blockingApplySettlement: view.branchStore.blockingApplySettlement,
      });
      const watermark = (await view.persistence.journal.read(ALPHA_ID)).persistenceWatermark;
      expect(watermark).toBeGreaterThan(0);
      expect(await catchUp(rebase)).toMatchObject({ kind: "rebased" });
      const row = await draftRow();
      expect(row.baseRevision).toMatchObject({ seq: watermark });
      expect((await read()).base).toEqual(["Alpha Beta.", "Blue."]);
      expect(await catchUp(rebase)).toEqual({ kind: "noop", reason: "current" });
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  // Risk: a revision certifying text the base has not read, so the next rebase skips that edit forever.
  it("never labels the base newer than the text it read when a socket admission commits mid-read", async () => {
    const { harness, view, draftRow, read, catchUp } = await setup();
    try {
      const journal = view.persistence.journal;
      let raced = false;
      const racing = {
        ...journal,
        read: async (...args: Parameters<typeof journal.read>) => {
          const snapshot = await journal.read(...args);
          if (!raced) {
            raced = true;
            // The admission lands after this read has fixed its cut.
            await view.persistence.lifecycle.ensureDocument(ALPHA_ID);
            await view.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
              const before = Y.encodeStateVector(doc);
              firstText(doc, "prosemirror").insert(0, "Raced ");
              await journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
                origin: `human:${USER_ID}`,
                seq: 0,
              });
            });
          }
          return snapshot;
        },
      };
      await db
        .update(schema.documentBranches)
        .set({ baseRevision: { authorityId: "unknown", authorityGeneration: "0", seq: 0 } })
        .where(eq(schema.documentBranches.id, (await draftRow()).id));
      const rebase = createDraftRebase({
        branchCoordinator: view.branchCoordinator,
        liveCut: createLiveCutReader(racing),
        blockingApplySettlement: view.branchStore.blockingApplySettlement,
      });
      expect(await catchUp(rebase)).toMatchObject({ kind: "rebased" });
      const certified = (await draftRow()).baseRevision;
      expect((await read()).base.join("")).not.toContain("Raced");
      // The raced edit is newer than the certified revision, so the next catch-up reads it.
      expect(await catchUp(rebase)).toMatchObject({ kind: "rebased" });
      expect((await read()).base.join("")).toContain("Raced");
      expect((await draftRow()).baseRevision?.seq).toBeGreaterThan(certified?.seq ?? 0);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});

describe("late-peer recovery in writer admission", () => {
  const journalRows = async (branchId: string) =>
    db
      .select({ id: schema.branchWriteJournal.id, source: schema.branchWriteJournal.source })
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.branchId, branchId));

  // Risk: a writer typing while live moves loses the words (Yjs merges them under deleted text), or the
  // recovery lands as a second row that a review can attribute to nobody.
  it("restores typing a rebase moved as the same single writer row, and keeps the rebase's deletion", async () => {
    const { harness, draftRow, decode, read, rebaseTo, writerUpdate } = await setup();
    try {
      const start = (await draftRow()).baseRevision?.seq ?? 0;
      await rebaseTo(start + 1, paragraphs("The fox ran. The dog slept.", "Blue."));
      const seeded = await draftRow();
      const peer = decode(seeded.state);
      const rowsBefore = (await journalRows(seeded.id)).length;
      // Live deletes a sentence and retypes the paragraph as a heading; the rebase replaces the
      // draft's paragraph, so the peer's typing now sits under a deleted block.
      await rebaseTo(start + 2, [
        pm.node("heading", { level: 2 }, [pm.text("The fox ran.")]),
        ...paragraphs("Blue."),
      ]);
      const rebased = await draftRow();
      const outcome = await writerUpdate(
        peer,
        decode(rebased.state),
        (d) => firstText(d, "prosemirror").insert(8, "quickly "),
        rebased.id,
      );
      expect(outcome).toMatchObject({ admitted: true });
      const { draft } = await read();
      expect(draft.join("\n")).toContain("quickly");
      expect(draft.join("\n")).not.toContain("slept");
      expect(draft.join("\n").split("quickly")).toHaveLength(2);
      const rows = await journalRows(seeded.id);
      expect(rows.length - rowsBefore).toBe(1);
      expect(rows.at(-1)?.source).toBe("writer");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});
