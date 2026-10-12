/**
 * Apply binds what the writer reviewed (contract §10.5, §10.8, ledger E-3a, E-3b): the
 * holders a publication admits are bound from the link meanings staged with it, the link
 * cut is fenced (a link typed after it registers again), a model's copy keeps the meaning,
 * and a staged meaning survives a crash and a Discard of its target: recovery binds it,
 * the target reads gone, and a later document at its path doesn't capture it.
 */
import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import { expect, it } from "vitest";
import { typeLink } from "../../test-support/draft-tree-scenario.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";

const KAEL = "manuscript://characters/kael";
const MIRA = "manuscript://characters/mira";

describeDraftTreeDb("Apply binds what the writer reviewed (postgres)", (start) => {
  it("binds a published holder's pasted, minted and late-typed refs to the draft's meaning, and a copy keeps it (E-3a)", async () => {
    const { s } = await start();
    const [ascension, direct] = [
      await s.work("Ascension", "draft"),
      await s.work("Direct", "direct"),
    ];
    const kael = await s.model(ascension).create("characters/kael", "Kael.");
    // A live ref minted after D's create: the registry has it, D's settlement doesn't.
    const one = await s.writer.createDocument("chapter-one", "[Kael](characters/kael) waits.");
    const [stored] = await s.storedLinks(one);
    const pasted = stored?.ref?.replace(/^ahead:/, "") ?? "";
    expect.soft(stored?.ref, "the live mint").toMatch(/^ahead:/);
    const two = await s.writer.createDocument("chapter-two", "Two.");
    await s.model(ascension).edit("chapter-two", "Two.", "Two, drafted.");
    // Pasted into D's chapter two, and a fresh editor mint just before Apply (no debounce).
    await s.writer.editDraft(ascension, two, typeLink(KAEL, pasted));
    const minted = randomUUID();
    await s.writer.editDraft(ascension, two, typeLink(KAEL, minted));
    // An item named twice is refused before anything registers or stages (E-R1).
    const twice = (await s.items(ascension)).find((item) => item.documentId === two);
    await expect(
      s.applyAll(ascension, { items: twice ? [twice, twice] : [] }),
      "a duplicate selection",
    ).rejects.toMatchObject({ statusCode: 400 });
    expect.soft(await s.batchStates(), "nothing staged").toEqual([]);
    expect
      .soft(
        (await s.review(ascension)).drafts.map((draft) => draft.documentId),
        "its rows still reviewable",
      )
      .toContain(two);
    // The writer types once more between the link cut and staging: the fence (F18)
    // registers again, so that link keeps D's meaning too.
    const late = randomUUID();
    const typeLate = setCollabHook("applyItems.afterLinkCut", async () => {
      typeLate();
      await s.writer.editDraft(ascension, two, typeLink(KAEL, late));
    });
    const [applied] = await s.apply(ascension, [two], { tokens: "none" });
    typeLate();
    expect.soft(applied?.httpStatus, "chapter two applies alone").toBe(200);

    const meaning = (ref: string, holder: { uri: string; id: DocumentId }) =>
      s.liveMeaning({ ref, href: KAEL, holder });
    const chapterTwo = { uri: "manuscript://chapter-two", id: two };
    const inDraft = { id: kael, inDraft: true, bound: true };
    expect.soft(await meaning(`ahead:${pasted}`, chapterTwo), "pasted").toEqual(inDraft);
    expect.soft(await meaning(`ahead:${minted}`, chapterTwo), "minted").toEqual(inDraft);
    expect.soft(await meaning(`ahead:${late}`, chapterTwo), "typed after the cut").toEqual(inDraft);
    expect
      .soft(
        await meaning(`ahead:${pasted}`, { uri: "manuscript://chapter-one", id: one }),
        "the live chapter",
      )
      .toBe("missing");
    // A model's copy into a third chapter keeps the meaning (doc:, §10.6).
    await s.model(direct).copy("chapter-two", "chapter-three");
    const three = (await s.view("live").idAt("chapter-three")) as DocumentId;
    expect
      .soft(
        (await s.storedLinks(three)).map((link) => link.ref),
        "rebound to the document",
      )
      .toContain(`doc:${kael}`);
    expect
      .soft(
        await meaning(`doc:${kael}`, { uri: "manuscript://chapter-three", id: three }),
        "the copy reads in a draft",
      )
      .toEqual({ id: kael, inDraft: true });

    // 12b-Q3: the later Apply's binding wins for that holder only. One ref means kael in
    // Ascension's draft and vela in Beacon's (seeded: a second draft's create at the
    // same path would join the first's document). Ascension publishes it into chapters
    // two and six; Beacon then publishes it into chapter two again.
    const beacon = await s.work("Beacon", "draft");
    const vela = await s.model(beacon).create("characters/vela", "Vela.");
    const shared = await s.seedAhead("characters/shared");
    await s.seedDraftSettlement(ascension, shared, kael);
    await s.seedDraftSettlement(beacon, shared, vela);
    const SHARED = "manuscript://characters/shared";
    const six = await s.writer.createDocument("chapter-six", "Six.");
    await s.model(ascension).edit("chapter-six", "Six.", "Six, drafted.");
    await s.model(ascension).edit("chapter-two", "Two, drafted.", "Two, drafted twice.");
    await s.writer.editDraft(ascension, two, typeLink(SHARED, shared));
    await s.writer.editDraft(ascension, six, typeLink(SHARED, shared));
    expect
      .soft((await s.apply(ascension, [two, six])).map((result) => result.httpStatus))
      .toEqual([200, 200]);
    const chapterSix = { uri: "manuscript://chapter-six", id: six };
    const sharedIn = (holder: { uri: string; id: DocumentId }) =>
      s.liveMeaning({ ref: `ahead:${shared}`, href: SHARED, holder });
    expect.soft(await sharedIn(chapterTwo), "Ascension's binding in two").toEqual(inDraft);
    expect.soft(await sharedIn(chapterSix), "Ascension's binding in six").toEqual(inDraft);
    await s.model(beacon).edit("chapter-two", "Two, drafted twice.", "Two, Beacon's.");
    await s.writer.editDraft(beacon, two, typeLink(SHARED, shared));
    expect.soft((await s.apply(beacon, [two])).map((result) => result.httpStatus)).toEqual([200]);
    expect
      .soft(await sharedIn(chapterTwo), "the later Apply's binding wins in two")
      .toEqual({ id: vela, inDraft: true, bound: true });
    expect.soft(await sharedIn(chapterSix), "six keeps Ascension's binding").toEqual(inDraft);
    for (const holder of [two, six]) {
      const refs = (await s.storedLinks(holder)).map((link) => link.ref);
      expect.soft(refs, "the holder's text still says ahead").toContain(`ahead:${shared}`);
      expect.soft(refs, "no meaning written into the text").not.toContain(`doc:${vela}`);
      expect.soft(refs, "nor the first draft's").not.toContain(`doc:${kael}`);
    }
  });

  it("binds from the staged snapshot across a crash and a Discard of the target, and nothing captures it later (E-3b)", async () => {
    const { s } = await start();
    const beacon = await s.work("Beacon", "draft");
    const mira = await s.model(beacon).create("characters/mira", "Mira.");
    const four = await s.writer.createDocument("chapter-four", "Four.");
    await s.model(beacon).edit("chapter-four", "Four.", "Four, drafted.");
    const forward = randomUUID();
    await s.writer.editDraft(beacon, four, typeLink(MIRA, forward));
    const remove = setCollabHook("applyItems.afterStaging", async () => {
      remove();
      throw new Error("injected process death after staging");
    });
    await expect(s.apply(beacon, [four]), "the warm owner dies").rejects.toThrow(
      "injected process death",
    );
    await s.discard(beacon, [mira]);
    await s.expirePendingClaims();
    await expect(s.recover()).resolves.toBe(1);
    const chapterFour = { uri: "manuscript://chapter-four", id: four };
    const meaning = () =>
      s.liveMeaning({ ref: `ahead:${forward}`, href: MIRA, holder: chapterFour });
    expect
      .soft(await s.view("live").text("chapter-four"), "its text published")
      .toContain("drafted");
    expect.soft(await meaning(), "bound to the discarded target").toBe("gone");
    await s.writer.createDocument("characters/mira", "A new Mira.");
    expect.soft(await meaning(), "no capture").toBe("gone");
  });
});
