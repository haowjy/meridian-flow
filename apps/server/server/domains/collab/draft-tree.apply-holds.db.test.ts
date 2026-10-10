/**
 * Apply all and 5a holds (contract §11.2 step 3, §11.4, §11.5, ledger E-5, E-7a, E-7b):
 * one command with per-item results, an item whose path is taken stays held in the draft
 * while the rest apply, a held picture is a payload-only Apply, the draft closes only when
 * drained, and D40's switch goes through the same command.
 */
import type { DocumentId } from "@meridian/contracts";
import { expect, it } from "vitest";
import {
  handleWorkWriteModeRequest,
  selectWorkWriteModeServices,
} from "../../lib/work-write-mode-route.js";
import { itemFor } from "../../test-support/draft-tree-scenario.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";

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
      status: "applied",
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
      status: "applied",
      draftClosed: true,
      items: [{ itemKey: keyOf(notes), status: "applied" }],
    });
    expect.soft(await s.draftStatuses(ascension)).toEqual(["closed"]);
  });

  it("applies the whole draft through the same command when D40 switches to auto-apply (E-7b)", async () => {
    const { runtime, s } = await start();
    const beacon = await s.work("Beacon", "draft");
    await s.writer.createDocument("other.md", "Other.");
    await s.model(beacon).edit("other.md", "Other.", "Other, drafted.");
    const mira = await s.model(beacon).create("characters/mira.md", "Mira.");
    const switched = await handleWorkWriteModeRequest(selectWorkWriteModeServices(runtime.app), {
      projectId: s.project.id,
      workId: beacon.id,
      userId: s.project.userId,
      aiWriteMode: "direct",
      pending: "apply",
    });
    expect.soft(switched).toMatchObject({ aiWriteMode: "direct" });
    expect.soft(await s.view("live").text("other.md")).toContain("Other, drafted.");
    expect.soft(await s.view("live").idAt("characters/mira.md")).toBe(mira);
    expect.soft(await s.draftStatuses(beacon), "D40 closed it").toEqual(["closed"]);
    expect.soft(await s.batchStates(), "one publication").toEqual(["completed"]);
  });
});
