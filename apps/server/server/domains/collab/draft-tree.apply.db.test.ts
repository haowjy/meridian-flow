/**
 * Apply as one publication (contract §11, §13, ledger E-1 to E-9): a draft's items apply
 * through the real review routes and the settlement seam's draft tree step: reveals,
 * restores and relocations publish with the text, 5a clashes are held per item, rendered
 * tokens refuse a stale review before or after staging, holder bindings carry what the
 * writer reviewed, Apply all is one command, and a content-bearing live create racing an
 * Apply of the same document ends with both done.
 */
import type { DocumentId, WorkId } from "@meridian/contracts";
import type { DraftReviewItemWire } from "@meridian/contracts/drafts";
import { createDb } from "@meridian/database";
import {
  branchPushSettlementBatches,
  documents,
  drafts,
  folders,
  linkAheadHolderBindings,
  linkAheadRefs,
  users,
} from "@meridian/database/schema";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  handleWorkWriteModeRequest,
  selectWorkWriteModeServices,
} from "../../lib/work-write-mode-route.js";
import { useComposedRuntimes } from "../../test-support/composed-runtime.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
  type ScenarioRuntime,
  type ScenarioWork,
} from "../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { interleave } from "../../test-support/lock-interleave.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Apply as one publication (postgres)", () => {});
} else {
  describe("Apply as one publication (postgres)", () => {
    // Settlement owns root transactions and the races run on several connections: commit.
    const db = createDb(DATABASE_URL, { max: 12 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      // Settlement batches belong to no user: clear them too, so each case counts its own.
      await deleteDrizzleRows(db, [users, branchPushSettlementBatches]);
    });

    async function start(): Promise<{ runtime: ScenarioRuntime; s: DraftTreeScenario }> {
      const runtime = await runtimes.compose();
      return { runtime, s: await draftTreeScenario(db, { runtime, runtimes }) };
    }

    /** A writer's live document with `content`. */
    async function live(s: DraftTreeScenario, path: string, content: string) {
      const created = await s.writer.create(path, { content });
      if (created.status !== "created" || !created.documentId) {
        throw new Error(`the writer's ${path} was not created`);
      }
      return created.documentId as DocumentId;
    }

    /** One saved reply in the Work's draft that replaces `find` in `path`. */
    async function draftEdit(
      s: DraftTreeScenario,
      work: ScenarioWork,
      path: string,
      find: string,
      content: string,
    ) {
      const reply = await s.model(work).reply();
      const uri = `manuscript://${path}`;
      expect((await reply.call("read", { path: uri })).isError).toBeFalsy();
      const written = await reply.call("write", { command: "replace", path: uri, find, content });
      expect(written.isError, JSON.stringify(written.output)).toBeFalsy();
      await reply.save();
    }

    async function liveText(s: DraftTreeScenario, path: string): Promise<string | null> {
      const read = await s.view("live").read(path);
      return read.ok ? read.value.content : null;
    }

    async function liveId(s: DraftTreeScenario, path: string): Promise<string | null> {
      const stat = await s.view("live").stat(path);
      return stat.ok ? (stat.value.documentId ?? null) : null;
    }

    async function itemsOf(s: DraftTreeScenario, work: ScenarioWork) {
      return (await s.review(work)).items;
    }

    function itemFor(items: readonly DraftReviewItemWire[], documentId: DocumentId) {
      const item = items.find((candidate) => candidate.documentId === documentId);
      if (!item) throw new Error(`no review item for ${documentId}`);
      return item;
    }

    async function draftStatus(work: ScenarioWork) {
      return (
        await db
          .select({ status: drafts.status })
          .from(drafts)
          .where(eq(drafts.originWorkId, work.id as WorkId))
      ).map((row) => row.status);
    }

    async function batchStates() {
      return (
        await db
          .select({ state: branchPushSettlementBatches.state })
          .from(branchPushSettlementBatches)
      ).map((row) => row.state);
    }

    /** As if the warm owner died: its claim on every pending batch has expired. */
    async function expirePendingClaims() {
      await db
        .update(branchPushSettlementBatches)
        .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(branchPushSettlementBatches.state, "pending"));
    }

    /** The stored link refs in a live document, by the address each names. */
    async function storedRefs(runtime: ScenarioRuntime, documentId: DocumentId) {
      return runtime.ports.documentSync.withLiveDocument(documentId, async ({ doc }) =>
        extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)).map((link) => ({
          ref: link.ref,
          href: link.href,
        })),
      );
    }

    /** The writer types a link in the draft's review room for this document. */
    function typeLink(href: string, aheadId: string) {
      return (doc: Y.Doc) => {
        const paragraph = new Y.XmlElement("paragraph");
        const text = new Y.XmlText();
        text.insert(0, "Kael", { link: { href, ref: `ahead:${aheadId}`, title: null } });
        paragraph.insert(0, [text]);
        doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).push([paragraph]);
      };
    }

    async function liveAnswer(
      s: DraftTreeScenario,
      ref: string,
      href: string,
      holder: { uri: string; id: DocumentId },
    ) {
      const { answer } = await s.linkAnswer({
        view: "live",
        ref,
        href,
        baseUri: holder.uri,
        holderDocumentId: holder.id,
      });
      return answer.state === "document"
        ? {
            id: answer.document.id,
            ...(answer.inDraft ? { inDraft: true } : {}),
            ...(answer.holderBound ? { bound: true } : {}),
          }
        : answer.state;
    }

    it("merges a create the writer also made live, names a live rename back, and refuses the model's later create usefully (E-1)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const kael = await s.model(ascension).create("characters/kael.md", "Kael guards the gate.");
      const hidden = await s.review(ascension);
      expect.soft(itemFor(hidden.items, kael), "new while hidden").toMatchObject({
        origin: "created",
        isNew: true,
        path: "manuscript://characters/kael.md",
        conflict: null,
      });
      expect
        .soft(hidden.drafts, "the legacy list shows it too, as new (early probe 1, 4)")
        .toMatchObject([
          { documentId: kael, contextPath: "/characters/kael.md", isNewDocument: true },
        ]);

      // The writer makes it live: one document, D's own.
      const made = await s.writer.create("characters/kael.md", { content: "Writer's Kael." });
      expect.soft(made, "the live create reveals D's document").toEqual({
        status: "created",
        documentId: kael,
      });
      // After the reveal it is an existing file: the model's create is refused, with guidance.
      const refused = await s.model(ascension).now("write", {
        command: "create",
        path: "manuscript://characters/kael.md",
        content: "A second Kael.",
      });
      expect
        .soft(JSON.stringify(refused.output), "create after reveal")
        .toContain(
          "File already exists: manuscript://characters/kael.md. Read it, then edit it; use overwrite=true only to replace all of its content.",
        );

      // The writer renames it live; Apply names it back at the draft's location.
      expect
        .soft(await s.writer.move("characters/kael.md", "characters/kael-fix.md"))
        .toMatchObject({ ok: true });
      await s.writer.write("characters/kael-fix.md", "Writer's Kael.\n\nThe writer's second line.");
      const reviewed = itemFor(await itemsOf(s, ascension), kael);
      expect.soft(reviewed, "revealed, then renamed live").toMatchObject({
        isNew: false,
        path: "manuscript://characters/kael.md",
        livePath: "manuscript://characters/kael-fix.md",
        conflict: { code: "rename_replaced", livePath: "manuscript://characters/kael-fix.md" },
      });
      const applied = await s.applyAll(ascension);
      expect.soft(applied, "one command, one publication").toEqual({
        status: "applied",
        draftId: reviewed.draftId,
        draftClosed: true,
        items: [
          {
            itemKey: reviewed.itemKey,
            status: "applied",
            notes: [
              {
                code: "rename_replaced",
                replacedPath: "manuscript://characters/kael-fix.md",
                path: "manuscript://characters/kael.md",
              },
            ],
          },
        ],
      });
      expect.soft(await liveId(s, "characters/kael.md"), "named back").toBe(kael);
      expect.soft(await liveId(s, "characters/kael-fix.md"), "the rename's path freed").toBeNull();
      const text = await liveText(s, "characters/kael.md");
      expect.soft(text, "the draft's text").toContain("Kael guards the gate.");
      expect.soft(text, "the writer's live edit").toContain("The writer's second line.");
      expect.soft(await draftStatus(ascension), "nothing pending: D closed").toEqual(["closed"]);
    });

    it("shows a second draft only its own part after the first applies their shared create (E-2)", async () => {
      const { runtime, s } = await start();
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      const kael = await s.model(ascension).create("characters/kael.md", "Ascension's Kael.");
      const joined = await s.model(beacon).create("characters/kael.md", "Beacon's Kael.");
      expect.soft(joined, "both drafts use one hidden document").toBe(kael);

      expect.soft((await s.applyAll(ascension)).status).toBe("applied");
      expect.soft(await liveText(s, "characters/kael.md")).toContain("Ascension's Kael.");
      const [item] = await itemsOf(s, beacon);
      expect.soft(item, "Beacon still has it, no longer new").toMatchObject({
        documentId: kael,
        origin: "created",
        isNew: false,
        conflict: null,
      });
      const preview = await runtime.ports.documentSync.draftReview.preview({
        workId: beacon.id,
        documentId: kael,
        draftId: item?.draftBranchId ?? "",
      });
      if (preview.status !== "active") throw new Error("Beacon's review is gone");
      const excerpts = preview.operations.map((operation) => operation.afterExcerpt ?? "");
      expect.soft(excerpts.join(" "), "Beacon's part").toContain("Beacon's Kael.");
      expect.soft(excerpts.join(" "), "never Ascension's").not.toContain("Ascension's Kael.");
      expect.soft(preview.live, "live is Ascension's").toContain("Ascension's Kael.");
      expect.soft(preview.item?.isNew, "the preview's item").toBe(false);
    });

    it("binds the holders it publishes to the meanings staged with them, even across a crash and a Discard (E-3)", async () => {
      const { runtime, s } = await start();
      const [ascension, beacon, direct] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
        await s.work("Direct", "direct"),
      ];
      const KAEL = "manuscript://characters/kael.md";
      const kael = await s.model(ascension).create("characters/kael.md", "Kael.");
      // A live ref minted after D's create: the registry has it, D's settlement doesn't.
      const one = await live(s, "chapter-one.md", "[Kael](characters/kael.md) waits.");
      const [registered] = await db
        .select({ aheadId: linkAheadRefs.aheadId })
        .from(linkAheadRefs)
        .where(eq(linkAheadRefs.path, "characters/kael.md"));
      const pasted = registered?.aheadId ?? "";
      expect.soft(pasted, "the live mint").not.toBe("");
      const two = await live(s, "chapter-two.md", "Two.");
      await draftEdit(s, ascension, "chapter-two.md", "Two.", "Two, drafted.");
      // Pasted into D's chapter two, and a fresh editor mint just before Apply (no debounce).
      await s.writer.editDraft(ascension, two, typeLink(KAEL, pasted));
      const minted = crypto.randomUUID();
      await s.writer.editDraft(ascension, two, typeLink(KAEL, minted));
      // The writer types once more between the link cut and staging: the fence (F18)
      // registers again, so that link keeps D's meaning too.
      const late = crypto.randomUUID();
      const typeLate = setCollabHook("applyItems.afterLinkCut", async () => {
        typeLate();
        await s.writer.editDraft(ascension, two, typeLink(KAEL, late));
      });
      const [applied] = await s.apply(ascension, [two], { tokens: "none" });
      typeLate();
      expect.soft(applied?.httpStatus, "chapter two applies alone").toBe(200);

      const chapterTwo = { uri: "manuscript://chapter-two.md", id: two };
      const chapterOne = { uri: "manuscript://chapter-one.md", id: one };
      expect
        .soft(await liveAnswer(s, `ahead:${pasted}`, KAEL, chapterTwo), "pasted: in a draft")
        .toEqual({ id: kael, inDraft: true, bound: true });
      expect
        .soft(await liveAnswer(s, `ahead:${minted}`, KAEL, chapterTwo), "minted: in a draft")
        .toEqual({ id: kael, inDraft: true, bound: true });
      expect
        .soft(await liveAnswer(s, `ahead:${late}`, KAEL, chapterTwo), "typed after the cut")
        .toEqual({ id: kael, inDraft: true, bound: true });
      expect
        .soft(await liveAnswer(s, `ahead:${pasted}`, KAEL, chapterOne), "the live chapter")
        .toBe("missing");
      // A model's copy into a third chapter keeps the meaning (doc:, §10.6).
      await s.model(direct).copy("chapter-two.md", "chapter-three.md");
      const three = (await liveId(s, "chapter-three.md")) as DocumentId;
      const copied = await storedRefs(runtime, three);
      expect
        .soft(
          copied.map((link) => link.ref),
          "rebound to the document",
        )
        .toContain(`doc:${kael}`);
      expect
        .soft(
          await liveAnswer(s, `doc:${kael}`, KAEL, {
            uri: "manuscript://chapter-three.md",
            id: three,
          }),
          "the copy reads in a draft",
        )
        .toEqual({ id: kael, inDraft: true });

      // V2-H4: Beacon's holder stages with Mira's meaning, the process dies, Mira is
      // discarded, recovery binds to Mira anyway: gone, and a later Mira can't capture it.
      const MIRA = "manuscript://characters/mira.md";
      const mira = await s.model(beacon).create("characters/mira.md", "Mira.");
      const four = await live(s, "chapter-four.md", "Four.");
      await draftEdit(s, beacon, "chapter-four.md", "Four.", "Four, drafted.");
      const forward = crypto.randomUUID();
      await s.writer.editDraft(beacon, four, typeLink(MIRA, forward));
      const remove = setCollabHook("applyItems.afterStaging", async () => {
        remove();
        throw new Error("injected process death after staging");
      });
      await expect(s.apply(beacon, [four]), "the warm owner dies").rejects.toThrow(
        "injected process death",
      );
      await s.discard(beacon, [mira]);
      await expirePendingClaims();
      await expect(runtime.ports.documentSync.recoverPendingLiveSettlements()).resolves.toBe(1);
      const chapterFour = { uri: "manuscript://chapter-four.md", id: four };
      expect
        .soft(
          await db
            .select({ documentId: linkAheadHolderBindings.documentId })
            .from(linkAheadHolderBindings)
            .where(
              and(
                eq(linkAheadHolderBindings.aheadId, forward),
                eq(linkAheadHolderBindings.holderDocumentId, four),
              ),
            ),
          "bound from the staged snapshot",
        )
        .toEqual([{ documentId: mira }]);
      expect.soft(await liveText(s, "chapter-four.md"), "its text published").toContain("drafted");
      expect
        .soft(await liveAnswer(s, `ahead:${forward}`, MIRA, chapterFour), "the discarded target")
        .toBe("gone");
      await live(s, "characters/mira.md", "A new Mira.");
      expect
        .soft(await liveAnswer(s, `ahead:${forward}`, MIRA, chapterFour), "no capture")
        .toBe("gone");
    });

    it("applies at the right path after a live folder rename absorbed the draft's hidden folder (E-4)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const notes = await s.model(ascension).create("ideas/kael/notes.md", "Notes.");
      const plan = await live(s, "drafts/plan.md", "Plan.");
      expect.soft(await s.writer.move("drafts", "ideas")).toMatchObject({ ok: true });
      const [item] = await itemsOf(s, ascension);
      expect.soft(item, "still new, at its path").toMatchObject({
        documentId: notes,
        isNew: true,
        path: "manuscript://ideas/kael/notes.md",
        conflict: null,
      });
      // The legacy per-document Apply of a hidden create (early probe 2: it answered 404).
      expect.soft(await s.apply(ascension, [notes], { tokens: "none" })).toEqual([
        {
          httpStatus: 200,
          body: {
            status: "applied",
            draftId: item?.draftBranchId,
            item: { itemKey: item?.itemKey, status: "applied", notes: [] },
          },
        },
      ]);
      expect.soft(await liveId(s, "ideas/kael/notes.md"), "at the draft's path").toBe(notes);
      expect.soft(await liveId(s, "ideas/plan.md"), "the renamed folder's file").toBe(plan);
      const ideas = await db
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.name, "ideas"), sql`${folders.deletedAt} IS NULL`));
      expect.soft(ideas, "one live ideas folder").toHaveLength(1);
    });

    it("holds the second draft's picture at a path the first's took, a payload-only Apply (E-5)", async () => {
      const { runtime, s } = await start();
      const { ports } = runtime;
      const { id: projectId, userId } = s.project;
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      for (const name of ["chart", "cover"]) {
        const bytes = new Uint8Array([137, 80, 78, 71, name.length]);
        const put = await ports.objectStore.put(`uploads/${projectId}/${name}`, bytes, "image/png");
        if (!put.ok) throw new Error(put.error.message);
        const uploaded = await ports.contextPorts
          .forProject(projectId, userId, new Map())
          .writeBinary(`manuscript://charts/${name}.png`, {
            fileType: "image",
            storageUrl: put.value.storageUrl,
            mimeType: "image/png",
            sizeBytes: bytes.byteLength,
          });
        if (!uploaded.ok) throw new Error(JSON.stringify(uploaded.error));
      }
      await s.model(ascension).copy("charts/chart.png", "art/map.png");
      await s.model(beacon).copy("charts/cover.png", "art/map.png");
      const [first] = await itemsOf(s, ascension);
      const [second] = await itemsOf(s, beacon);
      expect
        .soft([first?.binary, first?.draftBranchId], "an image has no branch")
        .toEqual([true, null]);
      expect.soft(first?.documentId, "two pictures").not.toBe(second?.documentId);

      expect.soft(await s.applyAll(ascension), "payload-only").toMatchObject({
        status: "applied",
        draftClosed: true,
        items: [{ itemKey: first?.itemKey, status: "applied", notes: [] }],
      });
      expect.soft(await liveId(s, "art/map.png"), "the first is live").toBe(first?.documentId);
      expect
        .soft(itemFor(await itemsOf(s, beacon), second?.documentId as DocumentId).conflict)
        .toEqual({
          code: "path_taken",
          path: "manuscript://art/map.png",
        });
      expect.soft(await s.applyAll(beacon), "the second is held").toMatchObject({
        status: "applied",
        draftClosed: false,
        items: [
          {
            itemKey: second?.itemKey,
            status: "held",
            reason: { code: "path_taken", path: "manuscript://art/map.png" },
          },
        ],
      });
      const beaconPicture = second?.documentId as DocumentId;
      const sign = (view: Parameters<typeof ports.figureAssets.getSignedFigureUrl>[0]["view"]) =>
        ports.figureAssets
          .getSignedFigureUrl({ projectId, assetDocumentId: beaconPicture, view })
          .then((signed) => (signed.ok ? "signed" : signed.error.code));
      expect
        .soft(await sign(await ports.documentSync.drafts.viewForWork(beacon.id)), "D's view")
        .toBe("signed");
      expect.soft(await sign({ kind: "live" }), "never live").toBe("document_not_found");
    });

    it("refuses a stale review before staging and abandons one raced or recovered after staging, deletions included (E-6)", async () => {
      const { runtime, s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const chapter = await live(s, "chapter.md", "Opening.\n\nMiddle.\n\nEnd.");
      await draftEdit(s, ascension, "chapter.md", "Opening.", "Opening, drafted.");
      const stale = async (change: () => Promise<unknown>) => {
        const rendered = await itemsOf(s, ascension);
        await change();
        return s.applyAll(ascension, { items: rendered });
      };
      const key = itemFor(await itemsOf(s, ascension), chapter).itemKey;
      const staleAnswer = { status: "stale", draftId: expect.any(String), staleItemKeys: [key] };

      expect
        .soft(await stale(() => s.writer.move("chapter.md", "chapter-1.md")), "a live rename")
        .toEqual(staleAnswer);
      expect
        .soft(
          await stale(() => s.writer.write("chapter-1.md", "Opening.\n\nMiddle.\n\nEnd.\n\nCoda.")),
          "a live edit",
        )
        .toEqual(staleAnswer);
      const vector = () =>
        runtime.ports.documentSync.withLiveDocument(chapter, async ({ doc }) =>
          Y.encodeStateVector(doc),
        );
      const before = await vector();
      expect
        .soft(
          await stale(() => s.writer.write("chapter-1.md", "Opening.\n\nEnd.\n\nCoda.")),
          "a delete-only edit",
        )
        .toEqual(staleAnswer);
      expect.soft(await vector(), "it inserted nothing (V2-H1)").toEqual(before);
      expect.soft(await batchStates(), "nothing staged").toEqual([]);

      // Raced between staging and completion: the batch is abandoned, rows reviewable.
      const raced = await interleave(
        db,
        () => s.applyAll(ascension),
        "applyItems.afterStaging",
        () => s.writer.move("chapter-1.md", "chapter-2.md"),
      );
      expect.soft(raced.b.ok, "the rename lands").toBe(true);
      expect.soft(raced.a, "completion refuses").toEqual({ ok: true, value: staleAnswer });
      expect.soft(await batchStates(), "abandoned").toEqual(["abandoned"]);
      // A delete-only change while the staged batch waits for recovery.
      const rendered = await itemsOf(s, ascension);
      const remove = setCollabHook("applyItems.afterStaging", async () => {
        remove();
        throw new Error("injected process death after staging");
      });
      await expect(s.applyAll(ascension, { items: rendered })).rejects.toThrow("process death");
      const beforeDelete = await vector();
      await s.writer.write("chapter-2.md", "Opening.\n\nCoda.");
      expect.soft(await vector(), "delete-only again").toEqual(beforeDelete);
      await expirePendingClaims();
      await runtime.ports.documentSync.recoverPendingLiveSettlements();
      expect.soft(await batchStates(), "recovery abandons it").toEqual(["abandoned", "abandoned"]);
      const after = itemFor(await itemsOf(s, ascension), chapter);
      expect.soft(after.draftBranchId, "still reviewable").not.toBeNull();
      expect.soft((await s.review(ascension)).drafts, "rows reviewable").toHaveLength(1);
      expect.soft(await liveText(s, "chapter-2.md"), "nothing published").not.toContain("drafted");
      expect.soft((await s.applyAll(ascension)).status, "a fresh review applies").toBe("applied");
      expect.soft(await liveText(s, "chapter-2.md")).toContain("Opening, drafted.");
    });

    it("applies all as one command with per-item results, holds a clash, closes only when drained, and serves D40's switch (E-7)", async () => {
      const { runtime, s } = await start();
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      const chapter = await live(s, "chapter.md", "Opening.");
      await draftEdit(s, ascension, "chapter.md", "Opening.", "Opening, drafted.");
      const kael = await s.model(ascension).create("characters/kael.md", "Kael.");
      const notes = await s.model(ascension).create("ideas/kael/notes.md", "Notes.");
      await live(s, "drafts/kael", "A file named kael.");
      expect.soft(await s.writer.move("drafts", "ideas")).toMatchObject({ ok: true });

      const items = await itemsOf(s, ascension);
      const keyOf = (documentId: DocumentId) => itemFor(items, documentId).itemKey;
      const first = await s.applyAll(ascension);
      expect.soft(first, "per-item results").toEqual({
        status: "applied",
        draftId: items[0]?.draftId,
        draftClosed: false,
        items: expect.arrayContaining([
          { itemKey: keyOf(chapter), status: "applied", notes: [] },
          { itemKey: keyOf(kael), status: "applied", notes: [] },
          {
            itemKey: keyOf(notes),
            status: "held",
            reason: { code: "path_taken", path: "manuscript://ideas/kael" },
          },
        ]),
      });
      expect.soft(await liveText(s, "chapter.md")).toContain("Opening, drafted.");
      expect.soft(await liveId(s, "characters/kael.md")).toBe(kael);
      expect.soft(await liveId(s, "ideas/kael/notes.md"), "held: still hidden").toBeNull();
      expect.soft(await draftStatus(ascension), "a held item keeps D open").toEqual(["active"]);
      expect.soft(await s.apply(ascension, [notes]), "the legacy Apply of a held item").toEqual([
        {
          httpStatus: 409,
          body: {
            status: "held",
            draftId: itemFor(items, notes).draftBranchId,
            reason: { code: "path_taken", path: "manuscript://ideas/kael" },
          },
        },
      ]);
      expect.soft(await s.writer.move("ideas/kael", "ideas/kael-file")).toMatchObject({ ok: true });
      expect.soft(await s.applyAll(ascension), "drained: D closes").toMatchObject({
        status: "applied",
        draftClosed: true,
        items: [{ itemKey: keyOf(notes), status: "applied" }],
      });
      expect.soft(await draftStatus(ascension)).toEqual(["closed"]);

      // D40: switching to auto-apply applies Beacon's whole draft through the same command.
      await live(s, "other.md", "Other.");
      await draftEdit(s, beacon, "other.md", "Other.", "Other, drafted.");
      const mira = await s.model(beacon).create("characters/mira.md", "Mira.");
      const switched = await handleWorkWriteModeRequest(selectWorkWriteModeServices(runtime.app), {
        projectId: s.project.id,
        workId: beacon.id,
        userId: s.project.userId,
        aiWriteMode: "direct",
        pending: "apply",
      });
      expect.soft(switched).toMatchObject({ aiWriteMode: "direct" });
      expect.soft(await liveText(s, "other.md")).toContain("Other, drafted.");
      expect.soft(await liveId(s, "characters/mira.md")).toBe(mira);
      expect.soft(await draftStatus(beacon), "D40 closed it").toEqual(["closed"]);
    });

    it("restores an edited document deleted live with its folder, and holds one whose path a new document took (E-8)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const harbor = await live(s, "lore/harbor.md", "The harbor.");
      const map = await live(s, "atlas/map.md", "The map.");
      await draftEdit(s, ascension, "lore/harbor.md", "The harbor.", "The harbor, drafted.");
      await draftEdit(s, ascension, "atlas/map.md", "The map.", "The map, drafted.");
      expect.soft((await s.writer.delete("lore")).ok, "the folder deleted live").toBe(true);
      expect.soft((await s.writer.delete("atlas/map.md")).ok).toBe(true);
      const newMap = await live(s, "atlas/map.md", "A new map.");

      const items = await itemsOf(s, ascension);
      expect.soft(itemFor(items, harbor), "deleted live, still the draft's").toMatchObject({
        path: "manuscript://lore/harbor.md",
        conflict: { code: "deleted_live" },
      });
      expect.soft(itemFor(items, map).conflict, "its path taken").toEqual({
        code: "path_taken",
        path: "manuscript://atlas/map.md",
      });
      expect.soft(await s.applyAll(ascension)).toMatchObject({
        status: "applied",
        draftClosed: false,
        items: expect.arrayContaining([
          {
            itemKey: itemFor(items, harbor).itemKey,
            status: "applied",
            notes: [{ code: "restored", path: "manuscript://lore/harbor.md" }],
          },
          {
            itemKey: itemFor(items, map).itemKey,
            status: "held",
            reason: { code: "path_taken", path: "manuscript://atlas/map.md" },
          },
        ]),
      });
      expect.soft(await liveId(s, "lore/harbor.md"), "restored with its folder").toBe(harbor);
      expect.soft(await liveText(s, "lore/harbor.md")).toContain("The harbor, drafted.");
      expect.soft(await liveId(s, "atlas/map.md"), "the new map stays").toBe(newMap);
      const [mapRow] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, map));
      expect.soft(mapRow?.deletedAt, "the held one stays deleted").not.toBeNull();
    });

    it("lets a content-bearing live create and an Apply of the same document both finish (E-9)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const harbor = await live(s, "harbor.md", "The harbor.");
      const kael = await s.model(ascension).create("characters/kael.md", "Kael, drafted.");
      const rendered = await itemsOf(s, ascension);
      const raced = await interleave(
        db,
        () =>
          s.writer.create("characters/kael.md", {
            content: "Writer's Kael by the [harbor](../harbor.md).",
          }),
        "createLive.afterLease",
        () => s.applyAll(ascension, { items: rendered }),
      );
      expect.soft(raced.bBlocked, "the Apply waited on the create's lease").toBe(true);
      expect.soft(raced.a, "the create reveals D's document").toEqual({
        ok: true,
        value: { status: "created", documentId: kael },
      });
      expect.soft(raced.b, "the Apply finishes: its render moved").toMatchObject({
        ok: true,
        value: { status: "stale" },
      });
      const text = await liveText(s, "characters/kael.md");
      expect.soft(text, "exactly the created content").toContain("Writer's Kael by the");
      expect.soft(text).not.toContain("Kael, drafted.");
      expect
        .soft(
          await liveAnswer(s, `doc:${harbor}`, "manuscript://harbor.md", {
            uri: "manuscript://characters/kael.md",
            id: kael,
          }),
          "its link bound before the transaction",
        )
        .toEqual({ id: harbor });
      expect.soft((await s.applyAll(ascension)).status, "a fresh review applies").toBe("applied");
      expect.soft(await liveText(s, "characters/kael.md")).toContain("Kael, drafted.");
    });
  });
}
