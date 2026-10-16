/**
 * The Yjs writer's named risks: a rebase write that undoes a peer's concurrent deletion, a write that
 * differs from the merge it was given, and a late peer's edit that vanishes without being noticed.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import { blocksEqual } from "./equal.js";
import { readBlocks } from "./fragments.js";
import { genScenario, Rng, resetWords, show, toPM } from "./merge.fixtures.js";
import { rebase } from "./merge.js";
import { pmToY, writeBlocks } from "./writer.js";

const schema = buildDocumentSchema();
const FRAG = "prosemirror";
const para = (s: string) => schema.nodes.paragraph.create(null, s ? schema.text(s) : undefined);

function seeded(blocks: readonly PMNode[]): Y.Doc {
  const doc = new Y.Doc();
  doc.getXmlFragment(FRAG).insert(0, blocks.map(pmToY));
  return doc;
}

/** A replica of `server` whose edits since the fork come back as one update. */
function peerOf(server: Y.Doc, edit: (frag: Y.XmlFragment) => void) {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
  const before = Y.encodeStateVector(peer);
  edit(peer.getXmlFragment(FRAG));
  return Y.encodeStateAsUpdate(peer, before);
}

const textOf = (frag: Y.XmlFragment, i: number) =>
  (frag.get(i) as Y.XmlElement).get(0) as Y.XmlText;

describe("minimal Yjs writer", () => {
  // Risk: a rebase that retypes the middle of a paragraph brings back a word a peer just deleted.
  it("keeps a peer's concurrent deletion of a word the rebase did not change", () => {
    const merged = [para("AAA bbb ccc ddd EEE")]; // live changed the first and last words
    const run = (write: (doc: Y.Doc) => void) => {
      const server = seeded([para("aaa bbb ccc ddd eee")]);
      const peerUpdate = peerOf(server, (f) => textOf(f, 0).delete(8, 4)); // "ccc "
      server.transact(() => write(server));
      Y.applyUpdate(server, peerUpdate);
      return show(readBlocks(server.getXmlFragment(FRAG), schema));
    };
    const wholeFragment = run((d) =>
      updateYFragment(d, d.getXmlFragment(FRAG), schema.topNodeType.create(null, merged), {
        mapping: new Map(),
        isOMark: new Map(),
      } as never),
    );
    const minimal = run((d) => writeBlocks(d.getXmlFragment(FRAG), schema, merged));
    expect(wholeFragment).toBe("p[AAA bbb ccc ddd EEE]"); // today's path undoes the deletion
    expect(minimal).toBe("p[AAA bbb ddd EEE]");
  });

  // Risk: a long chapter or an unspaced script makes the writer retype text it should keep, or write
  // text that differs from the target (the old private encoder wrapped past 0xFFFF).
  it("writes exactly the target past the encoding boundary and keeps unspaced-script words", () => {
    const words = Array.from({ length: 8200 }, (_, i) => `w${i}`).join(" ");
    for (const [from, to] of [
      [words, `${words} END`],
      [`${words} tail`, `START ${words}`],
    ]) {
      const doc = seeded([para(from)]);
      doc.transact(() => writeBlocks(doc.getXmlFragment(FRAG), schema, [para(to)]));
      expect(readBlocks(doc.getXmlFragment(FRAG), schema)[0].textContent === to).toBe(true);
    }

    const server = seeded([para("今天小明走过森林来到河边看见老虎")]);
    const peerUpdate = peerOf(server, (f) => {
      const t = textOf(f, 0);
      t.delete(t.toString().indexOf("森林"), 2);
    });
    const target = para("昨日小明走过森林来到河边看见飞龙");
    server.transact(() => writeBlocks(server.getXmlFragment(FRAG), schema, [target]));
    Y.applyUpdate(server, peerUpdate);
    expect(readBlocks(server.getXmlFragment(FRAG), schema)[0].textContent).toBe(
      "昨日小明走过来到河边看见飞龙",
    );
  });

  // Risk: the written draft drifts from the merge (marks, attributes, types, splits, moves).
  it("writes exactly the merge over 150 seeded rebases", () => {
    const wrong: string[] = [];
    for (let seed = 1; seed <= 150; seed++) {
      resetWords();
      const sc = genScenario(new Rng(seed), {});
      const [B, L, D] = [toPM(schema, sc.base), toPM(schema, sc.live), toPM(schema, sc.draft)];
      const { blocks } = rebase(schema, B, L, D);
      const doc = seeded(D);
      doc.transact(() => writeBlocks(doc.getXmlFragment(FRAG), schema, blocks));
      if (!blocksEqual(readBlocks(doc.getXmlFragment(FRAG), schema), blocks))
        wrong.push(`seed ${seed}`);
    }
    expect(wrong).toEqual([]);
  });
});
