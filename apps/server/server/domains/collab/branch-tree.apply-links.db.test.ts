/**
 * Ahead links bind once, on a live arrival, for every holder (12a as amended 2026-10-13):
 * until then each reader resolves the stored path in its own view, a draft's hidden
 * document there reads "in a draft" from every view, and a Discard that leaves no
 * document binds nothing, so the link reads "Doesn't exist yet" and a later live document
 * takes it. One walk of the design's case table.
 */
import type { DocumentId } from "@meridian/contracts";
import { linkAheadRefs } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { typeLink } from "../../test-support/branch-tree-commands.js";
import type { ScenarioWork } from "../../test-support/branch-tree-scenario.js";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";

const KAEL = "manuscript://characters/kael";
const MIRA = "manuscript://characters/mira";
const VELA = "manuscript://characters/vela";

describeBranchTreeDb("Ahead links bind once, on a live arrival (postgres)", (start, db) => {
  it("reads by address in each view until a live document binds it, and a Discard binds nothing", async () => {
    const { s } = await start();
    const [ascension, beacon] = [
      await s.work("Ascension", "draft"),
      await s.work("Beacon", "draft"),
    ];
    const kaelAhead = await s.seedAhead("characters/kael");
    const miraAhead = await s.seedAhead("characters/mira");
    const velaAhead = await s.seedAhead("characters/vela");
    const twelve = await s.writer.createDocument("chapter-twelve", "Twelve.");
    const chapter = { uri: "manuscript://chapter-twelve", id: twelve };

    /** What the ref means in a view (a Work's, or live): the document, "in a draft", or why not. */
    const read = async (view: ScenarioWork | "live", aheadId: string, href: string) => {
      const { answer } = await s.linkAnswer({
        view,
        ref: `ahead:${aheadId}`,
        href,
        baseUri: chapter.uri,
        holderDocumentId: chapter.id,
      });
      return answer.state === "document"
        ? { id: answer.document.id, ...(answer.inBranch ? { inBranch: true } : {}) }
        : answer.state;
    };
    const everywhere = async (aheadId: string, href: string) => ({
      ascension: await read(ascension, aheadId, href),
      beacon: await read(beacon, aheadId, href),
      live: await read("live", aheadId, href),
    });
    const settledTo = async (aheadId: string) =>
      (
        await db
          .select({ id: linkAheadRefs.settledDocumentId })
          .from(linkAheadRefs)
          .where(eq(linkAheadRefs.aheadId, aheadId))
      )[0]?.id ?? null;

    // Nothing exists at the path: every view says so.
    expect(await everywhere(kaelAhead, KAEL)).toEqual({
      ascension: "missing",
      beacon: "missing",
      live: "missing",
    });

    // D creates kael: every view reads D's document in a draft, and nothing is bound.
    const kael = await s.model(ascension).create("characters/kael", "Kael.");
    const inKael = { id: kael, inBranch: true };
    expect(await everywhere(kaelAhead, KAEL)).toEqual({
      ascension: inKael,
      beacon: inKael,
      live: inKael,
    });
    expect(await settledTo(kaelAhead)).toBeNull();

    // Another Work's draft is the only one at its path: D reads it in a draft too.
    const vela = await s.model(beacon).create("characters/vela", "Vela.");
    expect(await everywhere(velaAhead, VELA)).toEqual({
      ascension: { id: vela, inBranch: true },
      beacon: { id: vela, inBranch: true },
      live: { id: vela, inBranch: true },
    });

    // ch12 applied before its target: it still reads kael in a draft, nothing bound.
    await s.model(ascension).edit("chapter-twelve", "Twelve.", "Twelve, drafted.");
    await s.writer.editDraft(ascension, twelve, typeLink(KAEL, kaelAhead));
    expect((await s.apply(ascension, [twelve], { tokens: "none" }))[0]?.httpStatus).toBe(200);
    expect(await s.liveMeaning({ ref: `ahead:${kaelAhead}`, href: KAEL, holder: chapter })).toEqual(
      inKael,
    );
    expect(await settledTo(kaelAhead)).toBeNull();

    // The target applied: the reveal binds it once, and every view reads the live document.
    expect((await s.apply(ascension, [kael], { tokens: "none" }))[0]?.httpStatus).toBe(200);
    expect(await settledTo(kaelAhead)).toBe(kael);
    expect(await everywhere(kaelAhead, KAEL)).toEqual({
      ascension: { id: kael },
      beacon: { id: kael },
      live: { id: kael },
    });

    // The target's draft discarded, never revealed: nothing was bound, so the link reads
    // "Doesn't exist yet" everywhere, and a later live document takes it.
    const mira = await s.model(ascension).create("characters/mira", "Mira.");
    expect(await read("live", miraAhead, MIRA)).toEqual({ id: mira, inBranch: true });
    await s.discard(ascension, [mira]);
    expect(await everywhere(miraAhead, MIRA)).toEqual({
      ascension: "missing",
      beacon: "missing",
      live: "missing",
    });
    const liveMira = (await s.writer.createDocument(
      "characters/mira",
      "A new Mira.",
    )) as DocumentId;
    expect(await settledTo(miraAhead)).toBe(liveMira);
    expect(await everywhere(miraAhead, MIRA)).toEqual({
      ascension: { id: liveMira },
      beacon: { id: liveMira },
      live: { id: liveMira },
    });
  });
});
