/**
 * Apply all and 5a holds (contract §11.2 step 3, §11.4, §11.5, ledger E-5, E-7a, E-7b):
 * one command with per-item results, an item whose path is taken stays held in the draft
 * while the rest apply, a held picture is a payload-only Apply, and Apply never closes the
 * draft (D59, E-7b).
 */
import type { DocumentId } from "@meridian/contracts";
import { expect, it } from "vitest";
import { itemFor } from "../../test-support/draft-tree-scenario.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";

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
      .soft([first?.binary, first?.branchGeneration], "an image has no branch")
      .toEqual([true, null]);
    expect.soft(first?.documentId, "two pictures").not.toBe(second?.documentId);

    expect.soft(await s.applyAll(ascension), "payload-only").toMatchObject({
      status: "completed",
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

  it("applies all as one command with per-item results, holds a clash and keeps the draft open (E-7a)", async () => {
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
    expect.soft(await s.apply(ascension, [notes]), "the Apply of a held item").toEqual([
      {
        httpStatus: 409,
        body: {
          status: "held",
          draftId: itemFor(items, notes).draftId,
          itemKey: itemFor(items, notes).itemKey,
          reason: { code: "path_taken", path: "manuscript://ideas/kael" },
        },
      },
    ]);
    expect.soft(await s.writer.move("ideas/kael", "ideas/kael-file")).toMatchObject({ ok: true });
    expect.soft(await s.applyAll(ascension), "drained: D stays open (§2.4)").toMatchObject({
      status: "completed",
      items: [{ itemKey: keyOf(notes), status: "applied" }],
    });
    expect.soft(await s.draftStatuses(ascension)).toEqual(["active"]);
  });

  it("finishes an Apply whose draft grows mid-flight in the same request, (E-7b)", async () => {
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
    const original = await s.model(beacon).create("growth/original", "Original, drafted.");
    const [rendered] = await s.items(beacon);
    const stop = growAtStaging("growth/late");
    const grown = await s.applyAll(beacon);
    stop();
    expect.soft(grown, "the staged batch finishes with real results").toEqual({
      status: "completed",
      draftId: rendered?.draftId,
      items: [{ itemKey: rendered?.itemKey, status: "applied", notes: [] }],
    });
    expect.soft(await live.idAt("growth/original"), "applied").toBe(original);
    expect.soft(await live.idAt("growth/late"), "the late item stays in D").toBeNull();
    expect.soft(await s.batchStates(), "one batch, completed").toEqual(["completed"]);
  });
});
