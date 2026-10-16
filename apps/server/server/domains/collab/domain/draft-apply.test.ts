/**
 * Where a content Apply lands in live (contract §2.2). Placement comes from the rebase's own
 * whole-document alignment, so a change keeps its place when live adds, splits or reorders text
 * around it; and after the Apply the rebased draft and the new live agree on every copy.
 */
import {
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  rebase,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { planContentApply, rebuildSeen } from "./draft-apply.js";

const schema = buildDocumentSchema();
const p = (text: string) => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const texts = (blocks: readonly PMNode[]) => blocks.map((block) => block.textContent);

function docOf(fragments: Record<string, readonly PMNode[]>): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  doc.clientID = 1;
  doc.transact(() => {
    for (const [name, blocks] of Object.entries(fragments))
      writeBlocks(doc.getXmlFragment(name), schema, blocks);
  });
  return doc;
}

/** The writer reviews `draft` against `base`, then live moves to `live`; he applies his `pick`ed group. */
function apply(input: {
  base: PMNode[];
  draft: PMNode[];
  live: PMNode[];
  pick: (index: number) => boolean;
}) {
  const branch = docOf({
    [PROSEMIRROR_FRAGMENT_NAME]: input.draft,
    [REVIEW_BASE_FRAGMENT]: input.base,
  });
  const projection = projectReview(diffBlocks(input.base, input.draft));
  const groupIds = projection.groups.filter((_, i) => input.pick(i)).map((g) => g.id);
  const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(branch))).toString("base64");
  const liveDoc = docOf({ [PROSEMIRROR_FRAGMENT_NAME]: input.live });
  const planned = planContentApply({
    input: { scope: "changes", changeIds: groupIds, snapshot },
    branchState: Y.encodeStateAsUpdate(branch),
    liveState: Y.encodeStateAsUpdate(liveDoc),
  });
  if (planned.status !== "plan") throw new Error(`expected a plan, got ${planned.status}`);
  Y.applyUpdate(liveDoc, planned.plan.pushUpdate);
  const merged = readBlocks(liveDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
  // The catch-up rebase the Apply ran first: the draft over the same live.
  const rebasedDraft = rebase(schema, input.base, input.live, input.draft).blocks;
  return {
    merged,
    groups: projection.groups.length,
    leftInReview: projectReview(diffBlocks(merged, rebasedDraft)).groups.length,
  };
}

describe("content Apply placement", () => {
  it("applies the change once, to a fixed one of the equal paragraphs, when live adds another", () => {
    const same = "The gate stood open at dawn.";
    const result = apply({
      base: [p(same), p(same), p("Tail.")],
      draft: [p(same), p("The gate stood wide open at dawn."), p("Tail.")],
      live: [p(same), p(same), p(same), p("Tail.")],
      pick: () => true,
    });
    // Equal paragraphs are ambiguous to a content merge; the accepted rule is a fixed one (the last).
    const gate = "The gate stood open at dawn.";
    expect(texts(result.merged)).toEqual([
      gate,
      gate,
      "The gate stood wide open at dawn.",
      "Tail.",
    ]);
    expect(result.leftInReview).toBe(0);
  });

  it("follows the change through a live split inside it", () => {
    const result = apply({
      base: [p("one two three four five six seven eight nine"), p("Tail.")],
      draft: [p("one two three FOUR FIVE six seven eight nine"), p("Tail.")],
      live: [p("one two three four five"), p("six seven eight nine"), p("Tail.")],
      pick: () => true,
    });
    expect(texts(result.merged)).toEqual([
      "one two three FOUR FIVE",
      "six seven eight nine",
      "Tail.",
    ]);
    expect(result.leftInReview).toBe(0);
  });

  it("moves a paragraph even when live inserted one in between", () => {
    const [a, b, c, d] = [
      "Alpha walked the long road toward the northern gate.",
      "Beta watched the harbor lights fade into evening mist.",
      "Gamma counted the coins left in the ledger twice.",
      "Delta closed the window against the rising wind.",
    ];
    const result = apply({
      base: [p(a), p(b), p(c), p(d)],
      draft: [p(b), p(c), p(d), p(a)],
      live: [p(a), p(b), p("Live added a paragraph of its own here."), p(c), p(d)],
      pick: () => true,
    });
    expect(texts(result.merged)).toEqual([b, "Live added a paragraph of its own here.", c, d, a]);
    expect(result.leftInReview).toBe(0);
  });

  it("applies one of two groups and leaves the other in the review", () => {
    const base = [p("one two three four five six seven eight nine ten eleven twelve")];
    const draft = [p("ONE two three four five six seven eight nine ten eleven TWELVE")];
    const result = apply({ base, draft, live: base, pick: (i) => i === 0 });
    expect(result.groups).toBe(2);
    expect(texts(result.merged)).toEqual([
      "ONE two three four five six seven eight nine ten eleven twelve",
    ]);
    expect(result.leftInReview).toBe(1);
  });
});

describe("snapshot rebuild", () => {
  it("rebuilds the view the writer had after both the draft and live moved on", () => {
    const base = [p("alpha beta gamma delta epsilon zeta eta theta iota kappa")];
    const draft = [p("ALPHA beta gamma delta epsilon zeta eta theta iota KAPPA")];
    const branch = docOf({ [PROSEMIRROR_FRAGMENT_NAME]: draft, [REVIEW_BASE_FRAGMENT]: base });
    const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(branch))).toString("base64");
    const ids = projectReview(diffBlocks(base, draft)).groups.map((g) => g.id);
    // The draft keeps changing and the server rebases base and draft after the snapshot.
    branch.transact(() => {
      writeBlocks(branch.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, [
        p("ALPHA beta GAMMA delta epsilon zeta eta theta iota KAPPA"),
      ]);
      writeBlocks(branch.getXmlFragment(REVIEW_BASE_FRAGMENT), schema, [
        p("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"),
      ]);
    });
    const seen = rebuildSeen(branch, snapshot);
    expect(seen).not.toBeNull();
    if (!seen) return;
    expect(texts(seen.base)).toEqual(texts(base));
    expect(texts(seen.draft)).toEqual(texts(draft));
    const rebuilt = projectReview(diffBlocks(seen.base, seen.draft));
    expect(rebuilt.groups.map((g) => g.id)).toEqual(ids);
    const liveDoc = docOf({ [PROSEMIRROR_FRAGMENT_NAME]: base });
    const planned = planContentApply({
      input: { scope: "changes", changeIds: ids, snapshot },
      branchState: Y.encodeStateAsUpdate(branch),
      liveState: Y.encodeStateAsUpdate(liveDoc),
    });
    if (planned.status !== "plan") throw new Error(`expected a plan, got ${planned.status}`);
    expect(texts(planned.plan.merged)).toEqual(texts(draft));
  });

  it("refuses a snapshot that names items the server never received", () => {
    const branch = docOf({
      [PROSEMIRROR_FRAGMENT_NAME]: [p("a b c")],
      [REVIEW_BASE_FRAGMENT]: [p("a b c")],
    });
    const ahead = docOf({ [PROSEMIRROR_FRAGMENT_NAME]: [p("a b c")] });
    ahead.clientID = 77;
    ahead.transact(() =>
      writeBlocks(ahead.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, [p("a b c d")]),
    );
    const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(ahead))).toString("base64");
    expect(rebuildSeen(branch, snapshot)).toBeNull();
  });
});
