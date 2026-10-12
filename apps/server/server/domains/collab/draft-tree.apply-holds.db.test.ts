/**
 * Apply all and 5a holds (contract §11.2 step 3, §11.4, §11.5, ledger E-5, E-7a, E-7b):
 * one command with per-item results, an item whose path is taken stays held in the draft
 * while the rest apply, a held picture is a payload-only Apply, the draft closes only when
 * drained, and D40's switch goes through the same command, answering a batch handed to
 * recovery the way Apply does (E-7c).
 */
import type { DocumentId } from "@meridian/contracts";
import { expect, it, vi } from "vitest";
import { draftPublicationHttpAnswer } from "../../lib/draft-publication-http.js";
import {
  handleApplyWorkDraftRequest,
  selectDraftRouteServices,
} from "../../lib/draft-review-route.js";
import { HTTP_INTERRUPT_ENVELOPE_KEY } from "../../lib/interrupt-boundary.js";
import {
  handleWorkWriteModeRequest,
  selectWorkWriteModeServices,
} from "../../lib/work-write-mode-route.js";
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

  // #766 x F11: drafts and live creates share the name codec, and the shared document and
  // folder namespace is claimed in each view, so a hidden node never vetoes a live entry.
  it("names one canonical row across prose spellings and holds a folder-alias clash at Apply", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const rival = await s.work("Rival", "draft");
    const live = s.view("live");

    const kael = await s.model(ascension).create("characters/Kael", "Kael, drafted.");
    expect
      .soft(await s.model(rival).create("characters/Kael.txt", "Kael, the rival's."), "joined")
      .toBe(kael);
    expect.soft(await live.idAt("characters/Kael.md"), "hidden").toBeNull();
    expect
      .soft(await s.writer.create("characters/Kael.md"), "a live create of any spelling reveals it")
      .toEqual({ status: "created", documentId: kael });
    expect.soft(await live.idAt("characters/Kael"), "one canonical row, live").toBe(kael);

    // A visible folder alias holds the document name in the draft's view as it does live.
    await s.writer.mkdir("lore/Lore.md");
    const refused = await (await s.model(ascension).reply()).call("write", {
      command: "create",
      path: "manuscript://lore/Lore",
      content: "Refused.",
    });
    expect.soft(refused.isError, "a draft can't create under a folder's alias").toBe(true);

    // A hidden document never vetoes the live folder; Apply holds the draft's item instead.
    const map = await s.model(ascension).create("atlas/Map", "Map, drafted.");
    await s.writer.mkdir("atlas/Map.md");
    const items = await s.items(ascension);
    expect.soft(await s.applyAll(ascension), "held at its taken name").toMatchObject({
      status: "completed",
      items: expect.arrayContaining([
        {
          itemKey: itemFor(items, map).itemKey,
          status: "held",
          reason: { code: "path_taken", path: "manuscript://atlas/Map" },
        },
      ]),
    });
    expect.soft(await live.idAt("atlas/Map"), "still hidden").toBeNull();
  });

  // Review and Apply share the alias rule: a draft item whose name a folder alias holds is
  // a clash in review, and a live move that brings two hidden aliases together (F11 lets
  // it) holds both items while an unrelated one applies, never a whole-batch stale.
  it("reviews and holds document/folder alias clashes a live folder or move brings about (#766 x F11)", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const live = s.view("live");

    const lore = await s.model(ascension).create("Lore", "Lore, drafted.");
    await s.writer.mkdir("Lore.md");
    expect.soft(itemFor(await s.items(ascension), lore).conflict, "review sees the alias").toEqual({
      code: "path_taken",
      path: "manuscript://Lore",
    });

    const inner = await s.model(ascension).create("a/Inner", "Inner, drafted.");
    const chapter = await s.model(ascension).create("b/Inner.md/chapter", "Chapter, drafted.");
    const other = await s.model(ascension).create("other", "Other, drafted.");
    await s.writer.mkdir("a");
    expect
      .soft(await s.writer.move("a", "b"), "the live move absorbs hidden b (F11)")
      .toMatchObject({ ok: true });
    const items = await s.items(ascension);
    expect.soft(itemFor(items, inner).conflict, "the document meets folder Inner.md").toEqual({
      code: "path_taken",
      path: "manuscript://b/Inner",
    });
    expect.soft(itemFor(items, chapter).conflict, "its ancestor meets document Inner").toEqual({
      code: "path_taken",
      path: "manuscript://b/Inner.md",
    });
    const held = (documentId: DocumentId, path: string) => ({
      itemKey: itemFor(items, documentId).itemKey,
      status: "held",
      reason: { code: "path_taken", path: `manuscript://${path}` },
    });
    expect.soft(await s.applyAll(ascension), "per-item holds, never stale").toMatchObject({
      status: "completed",
      draftClosed: false,
      items: expect.arrayContaining([
        held(lore, "Lore"),
        held(inner, "b/Inner"),
        held(chapter, "b/Inner.md"),
        { itemKey: itemFor(items, other).itemKey, status: "applied", notes: [] },
      ]),
    });
    expect.soft(await live.idAt("other"), "the unrelated item applied").toBe(other);
    expect.soft(await live.idAt("b/Inner"), "held: still hidden").toBeNull();
    expect.soft(await live.idAt("b/Inner.md/chapter"), "held: still hidden").toBeNull();
  });

  it("applies all as one command with per-item results, holds a clash and closes only when drained (E-7a)", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const chapter = await s.writer.createDocument("chapter", "Opening.");
    await s.model(ascension).edit("chapter", "Opening.", "Opening, drafted.");
    const kael = await s.model(ascension).create("characters/kael", "Kael.");
    const notes = await s.model(ascension).create("ideas/kael/notes", "Notes.");
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
    expect.soft(await live.text("chapter")).toContain("Opening, drafted.");
    expect.soft(await live.idAt("characters/kael")).toBe(kael);
    expect.soft(await live.idAt("ideas/kael/notes"), "held: still hidden").toBeNull();
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
    const a = await s.model(cove).create("dep/a", "A, drafted.");
    await s.writer.create("dep/a", { content: "Writer's A." });
    expect.soft(await s.writer.move("dep/a", "dep/b")).toMatchObject({ ok: true });
    const x = await s.writer.createDocument("dep/a", "X.");
    const b = await s.model(cove).create("dep/b", "B, drafted.");
    const c = await s.model(cove).create("dep/c", "C, drafted.");
    const chain = await s.items(cove);
    const held = (documentId: DocumentId, path: string) => ({
      itemKey: itemFor(chain, documentId).itemKey,
      status: "held",
      reason: { code: "path_taken", path: `manuscript://${path}` },
    });
    expect
      .soft(await s.applyAll(cove, { items: [itemFor(chain, b)] }), "B alone: A stays at b")
      .toMatchObject({ status: "completed", items: [held(b, "dep/b")] });
    expect.soft(await s.applyAll(cove), "A and what only A frees stay").toMatchObject({
      status: "completed",
      draftClosed: false,
      items: expect.arrayContaining([
        held(a, "dep/a"),
        held(b, "dep/b"),
        { itemKey: itemFor(chain, c).itemKey, status: "applied", notes: [] },
      ]),
    });
    expect.soft(await live.idAt("dep/c"), "C applied").toBe(c);
    expect.soft(await live.idAt("dep/b"), "A still at b").toBe(a);
    expect.soft(await live.idAt("dep/a"), "X kept").toBe(x);
  });

  it("finishes an Apply whose draft grows mid-flight in the same request, through the route and D40 (E-7b)", async () => {
    const { runtime, s } = await start();
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
    const original = await s.model(beacon).create("growth/original", "Original, drafted.");
    const [rendered] = await s.items(beacon);
    const stop = growAtStaging("growth/late");
    const grown = await s.applyAll(beacon);
    stop();
    expect.soft(grown, "the staged batch finishes with real results").toEqual({
      status: "completed",
      draftId: rendered?.draftId,
      draftClosed: false,
      items: [{ itemKey: rendered?.itemKey, status: "applied", notes: [] }],
    });
    expect.soft(await live.idAt("growth/original"), "published").toBe(original);
    expect.soft(await live.idAt("growth/late"), "the late item stays in D").toBeNull();
    expect.soft(await s.batchStates(), "one batch, completed").toEqual(["completed"]);

    // D40: switching to auto-apply applies the whole draft through the same command and
    // completes even when the draft grows under it.
    await s.writer.createDocument("other", "Other.");
    await s.model(beacon).edit("other", "Other.", "Other, drafted.");
    const mira = await s.model(beacon).create("characters/mira", "Mira.");
    const stopAgain = growAtStaging("growth/later");
    const switched = await handleWorkWriteModeRequest(selectWorkWriteModeServices(runtime.app), {
      projectId: s.project.id,
      workId: beacon.id,
      userId: s.project.userId,
      aiWriteMode: "direct",
      pending: "apply",
    });
    stopAgain();
    expect.soft(switched).toMatchObject({ aiWriteMode: "direct" });
    expect.soft(await live.text("other")).toContain("Other, drafted.");
    expect.soft(await live.idAt("characters/mira")).toBe(mira);
    expect.soft(await live.idAt("growth/late"), "the earlier late item applied").not.toBeNull();
    expect.soft(await live.idAt("growth/later"), "the newest stays in D").toBeNull();
    expect.soft(await s.draftStatuses(beacon), "D stays open for it").toEqual(["active"]);
  });
  it.each([
    "switch",
    "all",
  ] as const)("answers pending when %s outgrows bounded continuation; recovery finishes the batch (E-7c)", async (kind) => {
    const { runtime, s } = await start();
    const beacon = await s.work("Beacon", "draft");
    const second = await s.thread(beacon);
    const original = await s.model(beacon).create("growth/original", "Original, drafted.");
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
    if (kind === "switch") {
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
    if (kind === "switch") {
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
      if (kind === "switch") {
        answer = await handleWorkWriteModeRequest(selectWorkWriteModeServices(runtime.app), {
          projectId: s.project.id,
          workId: beacon.id,
          userId: s.project.userId,
          aiWriteMode: "direct",
          pending: "apply",
        });
      } else {
        answer = await s.applyAll(beacon);
      }
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
    expect
      .soft((await runtime.ports.workRepo.findById(beacon.id))?.aiWriteMode, "the mode stays")
      .toBe("draft");
    expect.soft(await s.batchStates(), "one batch, with recovery").toEqual(["pending"]);
    // Handed off unclaimed, with a retry backoff: let it come due.
    await makePendingSettlementsDue(s.db);
    expect.soft(await s.recover(), "recovery finishes it").toBe(1);
    expect.soft(await s.view("live").idAt("growth/original"), "published").toBe(original);
  });
});
