/**
 * Apply all and 5a holds (contract §11.2 step 3, §11.4, §11.5, ledger E-5, E-7a, E-7b):
 * one command with per-item results, an item whose path is taken stays held in the draft
 * while the rest apply, a held picture is a payload-only Apply, the draft closes only when
 * drained, and a batch handed to recovery answers pending (E-7c).
 */
import type { DocumentId } from "@meridian/contracts";
import { expect, it, vi } from "vitest";
import { draftPublicationHttpAnswer } from "../../lib/draft-publication-http.js";
import {
  handleApplyWorkDraftRequest,
  selectDraftRouteServices,
} from "../../lib/draft-review-route.js";
import { HTTP_INTERRUPT_ENVELOPE_KEY } from "../../lib/interrupt-boundary.js";
import { itemFor } from "../../test-support/draft-tree-scenario.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { makePendingSettlementsDue } from "../../test-support/settlement-claims.js";
import { PublicationLeasesChangedError } from "./domain/branch-push-transition.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";
import {
  DraftApplyPendingError,
  DraftLinkRegistrationFailedError,
} from "./domain/draft-publication.js";

describeDraftTreeDb("Apply all and holds (postgres)", (start) => {
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
    const [first] = await s.items(ascension);
    const [second] = await s.items(beacon);
    expect
      .soft([first?.binary, first?.draftBranchId], "an image has no branch")
      .toEqual([true, null]);
    expect.soft(first?.documentId, "two pictures").not.toBe(second?.documentId);

    expect.soft(await s.applyAll(ascension), "payload-only").toMatchObject({
      status: "completed",
      draftClosed: true,
      items: [{ itemKey: first?.itemKey, status: "applied", notes: [] }],
    });
    expect
      .soft(await s.view("live").idAt("art/map.png"), "the first is live")
      .toBe(first?.documentId);
    const beaconPicture = second?.documentId as DocumentId;
    expect.soft(itemFor(await s.items(beacon), beaconPicture).conflict).toEqual({
      code: "path_taken",
      path: "manuscript://art/map.png",
    });
    expect.soft(await s.applyAll(beacon), "the second is held").toMatchObject({
      status: "completed",
      draftClosed: false,
      items: [
        {
          itemKey: second?.itemKey,
          status: "held",
          reason: { code: "path_taken", path: "manuscript://art/map.png" },
        },
      ],
    });
    const sign = (view: Parameters<typeof ports.figureAssets.getSignedFigureUrl>[0]["view"]) =>
      ports.figureAssets
        .getSignedFigureUrl({ projectId, assetDocumentId: beaconPicture, view })
        .then((signed) => (signed.ok ? "signed" : signed.error.code));
    expect
      .soft(await sign(await ports.documentSync.drafts.viewForWork(beacon.id)), "D's view")
      .toBe("signed");
    expect.soft(await sign({ kind: "live" }), "never live").toBe("document_not_found");
  });

  it("applies all as one command with per-item results, holds a clash and closes only when drained (E-7a)", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const chapter = await s.writer.createDocument("chapter.md", "Opening.");
    await s.model(ascension).edit("chapter.md", "Opening.", "Opening, drafted.");
    const kael = await s.model(ascension).create("characters/kael.md", "Kael.");
    const notes = await s.model(ascension).create("ideas/kael/notes.md", "Notes.");
    await s.writer.createDocument("drafts/kael", "A file named kael.");
    expect.soft(await s.writer.move("drafts", "ideas")).toMatchObject({ ok: true });

    const items = await s.items(ascension);
    const keyOf = (documentId: DocumentId) => itemFor(items, documentId).itemKey;
    expect.soft(await s.applyAll(ascension), "per-item results").toEqual({
      status: "completed",
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
    const live = s.view("live");
    expect.soft(await live.text("chapter.md")).toContain("Opening, drafted.");
    expect.soft(await live.idAt("characters/kael.md")).toBe(kael);
    expect.soft(await live.idAt("ideas/kael/notes.md"), "held: still hidden").toBeNull();
    expect.soft(await s.draftStatuses(ascension), "a held item keeps D open").toEqual(["active"]);
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
      status: "completed",
      draftClosed: true,
      items: [{ itemKey: keyOf(notes), status: "applied" }],
    });
    expect.soft(await s.draftStatuses(ascension)).toEqual(["closed"]);

    // 5a's dependency (E-R2): A is held at dep/a.md; B needs dep/b.md, which only A's move
    // back would free, so B is held too; independent C applies. Never a whole-batch stale.
    const cove = await s.work("Cove", "draft");
    const a = await s.model(cove).create("dep/a.md", "A, drafted.");
    await s.writer.create("dep/a.md", { content: "Writer's A." });
    expect.soft(await s.writer.move("dep/a.md", "dep/b.md")).toMatchObject({ ok: true });
    const x = await s.writer.createDocument("dep/a.md", "X.");
    const b = await s.model(cove).create("dep/b.md", "B, drafted.");
    const c = await s.model(cove).create("dep/c.md", "C, drafted.");
    const chain = await s.items(cove);
    const held = (documentId: DocumentId, path: string) => ({
      itemKey: itemFor(chain, documentId).itemKey,
      status: "held",
      reason: { code: "path_taken", path: `manuscript://${path}` },
    });
    expect
      .soft(await s.applyAll(cove, { items: [itemFor(chain, b)] }), "B alone: A stays at b.md")
      .toMatchObject({ status: "completed", items: [held(b, "dep/b.md")] });
    expect.soft(await s.applyAll(cove), "A and what only A frees stay").toMatchObject({
      status: "completed",
      draftClosed: false,
      items: expect.arrayContaining([
        held(a, "dep/a.md"),
        held(b, "dep/b.md"),
        { itemKey: itemFor(chain, c).itemKey, status: "applied", notes: [] },
      ]),
    });
    expect.soft(await live.idAt("dep/c.md"), "C applied").toBe(c);
    expect.soft(await live.idAt("dep/b.md"), "A still at b.md").toBe(a);
    expect.soft(await live.idAt("dep/a.md"), "X kept").toBe(x);
  });

  it("finishes an Apply whose draft grows mid-flight in the same request (E-7b)", async () => {
    const { s } = await start();
    const beacon = await s.work("Beacon", "draft");
    const second = await s.thread(beacon);
    const live = s.view("live");
    /** At staging, a second chat of the Work adds a document to the draft (F22). */
    const growAtStaging = (path: string) => {
      const remove = setCollabHook("applyItems.afterStaging", async () => {
        remove();
        await s.model(second).create(path, "Late, drafted.");
      });
      return remove;
    };
    const original = await s.model(beacon).create("growth/original.md", "Original, drafted.");
    const [rendered] = await s.items(beacon);
    const stop = growAtStaging("growth/late.md");
    const grown = await s.applyAll(beacon);
    stop();
    expect.soft(grown, "the staged batch finishes with real results").toEqual({
      status: "completed",
      draftId: rendered?.draftId,
      draftClosed: false,
      items: [{ itemKey: rendered?.itemKey, status: "applied", notes: [] }],
    });
    expect.soft(await live.idAt("growth/original.md"), "published").toBe(original);
    expect.soft(await live.idAt("growth/late.md"), "the late item stays in D").toBeNull();
    expect.soft(await s.batchStates(), "one batch, completed").toEqual(["completed"]);
  });
  it("answers pending when Apply all outgrows bounded continuation; recovery finishes the batch (E-7c)", async () => {
    const { runtime, s } = await start();
    const beacon = await s.work("Beacon", "draft");
    const second = await s.thread(beacon);
    const original = await s.model(beacon).create("growth/original.md", "Original, drafted.");
    // A second chat of the Work grows the draft at staging and at every continuation, past
    // the bounded re-leasing: the staged batch goes to recovery (F22).
    let grown = 0;
    const grow = async () => {
      grown += 1;
      await s.model(second).create(`growth/late-${grown}.md`, "Late, drafted.");
    };
    const stopStaging = setCollabHook("applyItems.afterStaging", async () => {
      stopStaging();
      await grow();
    });
    const stopContinue = setCollabHook("applyItems.beforeContinue", grow);
    const draftId = (await s.items(beacon))[0]?.draftId;
    {
      const failure = new DraftLinkRegistrationFailedError(draftId as string, []);
      let registrationAnswer: unknown;
      try {
        draftPublicationHttpAnswer(failure);
      } catch (cause) {
        registrationAnswer = cause;
      }
      expect.soft(registrationAnswer, "nothing staged is a typed retryable failure").toMatchObject({
        statusCode: 503,
        data: {
          [HTTP_INTERRUPT_ENVELOPE_KEY]: {
            kind: "error",
            error: {
              code: "draft_link_registration_failed",
              retryable: true,
              source: "system",
            },
          },
        },
      });
    }
    // Per-document Apply doesn't close D, so ordinary draft growth needs no new leases.
    // Its publication port can still hand off; it uses the same transport mapping.
    {
      const item = (await s.items(beacon))[0];
      if (!item?.draftBranchId || !draftId) throw new Error("Missing draft item");
      const deps = selectDraftRouteServices(runtime.app);
      const handoff = new PublicationLeasesChangedError("batch", [], {} as never);
      const apply = vi
        .spyOn(deps.documentSync.draftReview, "applyWorkDraft")
        .mockRejectedValueOnce(new DraftApplyPendingError(draftId, handoff));
      try {
        expect
          .soft(
            await handleApplyWorkDraftRequest(deps, {
              projectId: s.project.id,
              workId: beacon.id,
              userId: s.project.userId,
              documentId: original,
              draftId: item.draftBranchId,
            }),
          )
          .toEqual({ httpStatus: 202, body: { status: "pending", draftId } });
      } finally {
        apply.mockRestore();
      }
    }
    let answer: unknown;
    try {
      answer = await s.applyAll(beacon);
    } catch (cause) {
      answer = cause;
    } finally {
      stopStaging();
      stopContinue();
    }
    expect.soft(grown, "grown at staging and at each of three continuations").toBe(4);
    expect
      .soft(answer, "the handoff is accepted, never failed or updated")
      .toEqual({ status: "pending", draftId });
    expect.soft(await s.batchStates(), "one batch, with recovery").toEqual(["pending"]);
    // Handed off unclaimed, with a retry backoff: let it come due.
    await makePendingSettlementsDue(s.db);
    expect.soft(await s.recover(), "recovery finishes it").toBe(1);
    expect.soft(await s.view("live").idAt("growth/original.md"), "published").toBe(original);
  });
});
