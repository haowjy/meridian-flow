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

const KAEL = "manuscript://characters/kael.md";
const MIRA = "manuscript://characters/mira.md";

describeDraftTreeDb("Apply binds what the writer reviewed (postgres)", (start) => {
  it("binds a published holder's pasted, minted and late-typed refs to the draft's meaning, and a copy keeps it (E-3a)", async () => {
    const { s } = await start();
    const [ascension, direct] = [
      await s.work("Ascension", "draft"),
      await s.work("Direct", "direct"),
    ];
    const kael = await s.model(ascension).create("characters/kael.md", "Kael.");
    // A live ref minted after D's create: the registry has it, D's settlement doesn't.
    const one = await s.writer.createDocument(
      "chapter-one.md",
      "[Kael](characters/kael.md) waits.",
    );
    const [stored] = await s.storedLinks(one);
    const pasted = stored?.ref?.replace(/^ahead:/, "") ?? "";
    expect.soft(stored?.ref, "the live mint").toMatch(/^ahead:/);
    const two = await s.writer.createDocument("chapter-two.md", "Two.");
    await s.model(ascension).edit("chapter-two.md", "Two.", "Two, drafted.");
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
    const chapterTwo = { uri: "manuscript://chapter-two.md", id: two };
    const inDraft = { id: kael, inDraft: true, bound: true };
    expect.soft(await meaning(`ahead:${pasted}`, chapterTwo), "pasted").toEqual(inDraft);
    expect.soft(await meaning(`ahead:${minted}`, chapterTwo), "minted").toEqual(inDraft);
    expect.soft(await meaning(`ahead:${late}`, chapterTwo), "typed after the cut").toEqual(inDraft);
    expect
      .soft(
        await meaning(`ahead:${pasted}`, { uri: "manuscript://chapter-one.md", id: one }),
        "the live chapter",
      )
      .toBe("missing");
    // A model's copy into a third chapter keeps the meaning (doc:, §10.6).
    await s.model(direct).copy("chapter-two.md", "chapter-three.md");
    const three = (await s.view("live").idAt("chapter-three.md")) as DocumentId;
    expect
      .soft(
        (await s.storedLinks(three)).map((link) => link.ref),
        "rebound to the document",
      )
      .toContain(`doc:${kael}`);
    expect
      .soft(
        await meaning(`doc:${kael}`, { uri: "manuscript://chapter-three.md", id: three }),
        "the copy reads in a draft",
      )
      .toEqual({ id: kael, inDraft: true });
  });

  it("binds from the staged snapshot across a crash and a Discard of the target, and nothing captures it later (E-3b)", async () => {
    const { s } = await start();
    const beacon = await s.work("Beacon", "draft");
    const mira = await s.model(beacon).create("characters/mira.md", "Mira.");
    const four = await s.writer.createDocument("chapter-four.md", "Four.");
    await s.model(beacon).edit("chapter-four.md", "Four.", "Four, drafted.");
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
    const chapterFour = { uri: "manuscript://chapter-four.md", id: four };
    const meaning = () =>
      s.liveMeaning({ ref: `ahead:${forward}`, href: MIRA, holder: chapterFour });
    expect
      .soft(await s.view("live").text("chapter-four.md"), "its text published")
      .toContain("drafted");
    expect.soft(await meaning(), "bound to the discarded target").toBe("gone");
    await s.writer.createDocument("characters/mira.md", "A new Mira.");
    expect.soft(await meaning(), "no capture").toBe("gone");
  });
});
