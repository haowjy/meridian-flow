import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readBlocks } from "./fragments.js";
import { findLostEdits } from "./late-peer.js";
import { recoverLatePeerEdits } from "./late-peer-recovery.js";
import { genScenario, Rng, resetWords, show, toPM } from "./merge.fixtures.js";
import { rebase } from "./merge.js";
import { appendRebaseCut, captureRebaseCut } from "./rebase-cuts.js";
import { pmToY, writeBlocks } from "./writer.js";

const schema = buildDocumentSchema();
const FRAG = "prosemirror";
const para = (s: string) => schema.nodes.paragraph.create(null, s ? schema.text(s) : undefined);

function seeded(texts: string[]): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  doc.getXmlFragment(FRAG).insert(
    0,
    texts.map((t) => pmToY(para(t))),
  );
  return doc;
}

const forkOf = (server: Y.Doc) => {
  const peer = new Y.Doc({ gc: false });
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
  return peer;
};

/** The update `edit` makes on `peer`, as the provider sends it: the transaction's own bytes. */
function updateOf(peer: Y.Doc, edit: (frag: Y.XmlFragment) => void): Uint8Array {
  let update: Uint8Array = new Uint8Array();
  peer.once("update", (u: Uint8Array) => {
    update = u;
  });
  edit(peer.getXmlFragment(FRAG));
  return update;
}

/** Each server doc's stored rebase cuts, as `document_branches.rebase_cuts` holds them. */
const storedCuts = new WeakMap<Y.Doc, Uint8Array[]>();

/** A server rebase (the server doc is client 1): writes `blocks` and stores its cut. */
function writeWithRebaseCut(server: Y.Doc, _origin: string, write: () => void): void {
  const cut = captureRebaseCut(server);
  server.transact(write, "rebase");
  storedCuts.set(server, appendRebaseCut(storedCuts.get(server) ?? [], cut));
}

function rebaseTo(server: Y.Doc, target: string[]): void {
  writeWithRebaseCut(server, "rebase", () =>
    writeBlocks(server.getXmlFragment(FRAG), schema, target.map(para)),
  );
}

/** Lands `update` on `server` the way the coordinator does, then recovers. */
function land(server: Y.Doc, update: Uint8Array) {
  const before = Y.snapshot(server);
  const lost = findLostEdits(server, update);
  Y.applyUpdate(server, update);
  const result = recoverLatePeerEdits({
    doc: server,
    update,
    lost,
    before,
    cuts: storedCuts.get(server) ?? [],
    schema,
    fragmentName: FRAG,
    clientId: 1,
  });
  return { ...result, text: show(readBlocks(server.getXmlFragment(FRAG), schema)) };
}

/** A peer forked from `server`, then a rebase writes `target` into the server, then the peer's update lands. */
function late(
  texts: string[],
  target: string[],
  edit: (frag: Y.XmlFragment) => void,
): {
  doc: Y.Doc;
  update: Uint8Array | null;
  recovered: string[];
  unplaced: string[];
  fallback: string[];
  text: string;
} {
  const server = seeded(texts);
  const update = updateOf(forkOf(server), edit);
  rebaseTo(server, target);
  return { doc: server, ...land(server, update) };
}

const typeAt = (i: number, at: number, s: string) => (f: Y.XmlFragment) =>
  ((f.get(i) as Y.XmlElement).get(0) as Y.XmlText).insert(at, s);

const SEEDS = 400;

describe("late-peer recovery", () => {
  // Risk: typing into a paragraph the rebase deleted vanished silently, or revived the deleted words
  // around it. The late words survive beside the surviving neighbour; the deleted words stay deleted.
  it("keeps late typing, not the deleted words, when the rebase deleted the paragraph", () => {
    for (const [at, typed] of [
      [9, " late"],
      [0, "late "],
      [4, "late "],
    ] as const) {
      const r = late(["one", "two words", "three"], ["one", "three"], typeAt(1, at, typed));
      expect(r.text).toBe(`p[one] p[${typed}] p[three]`);
      expect(r.fallback).toEqual([typed]);
    }
  });

  // Risk: typing into a paragraph the rebase retyped lands in dead text, or a duplicate paragraph appears.
  it("merges typing into the paragraph that replaced a retyped one", () => {
    const r = late(
      ["alpha beta gamma", "tail"],
      ["tail", "ALPHA beta gamma"],
      typeAt(0, 16, " delta"),
    );
    expect(r.text).toBe("p[tail] p[ALPHA beta gamma delta]");
  });

  // Risk (D32): a deletion of text the rebase moved was redone on the new copy; the same delete set
  // arrives again on every reconnect, and redoing it erased words written since. It is log-only.
  it("leaves a late deletion of rebased text alone and reports it", () => {
    const r = late(["one two three four", "end"], ["one two", "three four", "end"], (f) =>
      ((f.get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(8, 6),
    );
    expect(r.update).toBeNull();
    expect(r.text).toBe("p[one two] p[three four] p[end]");
    expect(r.unplaced.join("")).toBe("three ");
  });

  it("changes nothing when the edit was not lost", () => {
    const r = late(["one", "two"], ["one", "two"], typeAt(1, 3, "!"));
    expect(r.update).toBeNull();
    expect(r.text).toBe("p[one] p[two!]");
  });

  // Risk: recovery rebuilt the view from today's state, so a rebase's replacement text was kept next to
  // the revived original and the visible sentence came back twice (spaceless script, one rebase).
  it("does not duplicate a visible sentence when a peer deletes a word the rebase replaced", () => {
    const r = late(
      ["昨日小明走过森林来到河边看见飞龙", "tail"],
      ["昨日小明走过森林来到河边看见飞龙今天", "tail"],
      (f) => ((f.get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(6, 2),
    );
    expect(r.text.match(/昨日小明走过/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(r.text).not.toContain("森林");
  });

  // Risk: a peer that saw rebase 1 and typed, then rebase 2 deleted the paragraph: the revived view held
  // the original word and its replacement at once ("ALPHAalpha beta gamma delta"), or the deleted
  // paragraph came back whole. Only the typed word survives.
  it("keeps only the typed word after two rebases, inventing and reviving nothing", () => {
    const server = seeded(["alpha beta gamma", "tail"]);
    rebaseTo(server, ["ALPHA beta gamma", "tail"]);
    const update = updateOf(forkOf(server), typeAt(0, 16, " delta"));
    rebaseTo(server, ["tail"]);
    const r = land(server, update);
    expect(r.text).toBe("p[ delta] p[tail]");
  });

  // Risk (D21): typed words the exact recovery cannot place vanish silently. They must land once, as their own
  // paragraph after the nearest surviving block that stood before them.
  it("writes typed words as their own paragraph when no cut can place them", () => {
    const server = seeded(["alpha", "beta gamma", "tail"]);
    const update = updateOf(forkOf(server), typeAt(1, 10, " delta"));
    for (let i = 0; i < 40; i++)
      rebaseTo(server, i % 2 ? ["alpha", "tail"] : ["alpha", "tail", "x"]);
    rebaseTo(server, ["alpha", "tail"]);
    const r = land(server, update);
    expect(r.text.split("delta").length - 1).toBe(1);
    expect(r.fallback).toEqual([" delta"]);
    expect(r.text).toMatch(/^p\[alpha\] p\[ delta\]/);
  });

  it("writes typed words as their own paragraph when the merge fails verification", () => {
    const server = seeded(["alpha beta gamma", "tail"]);
    const update = updateOf(forkOf(server), typeAt(0, 16, " zzqq"));
    // The rebase retyped the block and already holds the peer's word, so the merge adds nothing to verify.
    rebaseTo(server, ["tail", "ALPHA beta gamma zzqq"]);
    const r = land(server, update);
    expect(r.fallback).toEqual([" zzqq"]);
    expect(r.text).toBe("p[ zzqq] p[tail] p[ALPHA beta gamma zzqq]");
  });

  // Risk: a peer older than every retained cut (the history is capped) loses its typing, or recovery
  // resurrects text a rebase deleted because it had no cut to rebuild the block from.
  it("keeps a typed word as its own paragraph when the peer predates every retained cut", () => {
    const server = seeded(["alpha beta gamma", "tail"]);
    const update = updateOf(forkOf(server), (f) => {
      const text = (f.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      text.insert(5, " zzqq");
    });
    for (let i = 0; i < 40; i++) rebaseTo(server, [`step${i} delta`, "tail"]);
    expect(storedCuts.get(server)).toHaveLength(32);
    const r = land(server, update);
    expect(r.fallback).toEqual([" zzqq"]);
    expect(r.text.split("zzqq")).toHaveLength(2);
    expect(r.text).not.toContain("alpha");
  });

  // Risk: across random rebase histories (one or two rebases, the peer forking before or between them)
  // a late peer's typing is missing, or recovery writes text nobody typed.
  it("loses no typed word and invents none across random rebase histories", () => {
    const wrong: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      resetWords();
      const sc = genScenario(new Rng(seed), {});
      const base = toPM(schema, sc.base);
      if (!base.length) continue;
      const first = rebase(schema, base, toPM(schema, sc.live), base).blocks;
      resetWords();
      const second = rebase(
        schema,
        first,
        toPM(schema, genScenario(new Rng(seed + 1000), {}).live),
        first,
      ).blocks;
      const server = new Y.Doc({ gc: false });
      server.clientID = 1;
      server.getXmlFragment(FRAG).insert(0, base.map(pmToY));
      const rewrite = (blocks: readonly PMNode[]) =>
        writeWithRebaseCut(server, "rebase", () =>
          writeBlocks(server.getXmlFragment(FRAG), schema, blocks),
        );
      const forkAfterFirst = seed % 2 === 0;
      if (forkAfterFirst) rewrite(first);
      const peer = forkOf(server);
      const target = peer.getXmlFragment(FRAG).get(seed % peer.getXmlFragment(FRAG).length);
      const text = (target as Y.XmlElement | undefined)?.get(0) as Y.XmlText | undefined;
      if (!text || !(text instanceof Y.XmlText)) continue;
      const update = updateOf(peer, () => text.insert(Math.min(text.length, seed % 7), " zzqq "));
      if (!forkAfterFirst) rewrite(first);
      rewrite(second);
      land(server, update);
      const visible = show(readBlocks(server.getXmlFragment(FRAG), schema));
      const typed = visible.split("zzqq").length - 1;
      if (typed !== 1) wrong.push(`seed ${seed}`);
    }
    expect(wrong).toEqual([]);
  }, 30_000);
});
