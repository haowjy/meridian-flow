/** Consolidated test contracts; each block retains its original fixture scope. */

import { createHash } from "node:crypto";
import { type SemanticEditIRV1, toDocHandle } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { DraftId } from "@meridian/contracts";
import type { ReviewHunk } from "@meridian/contracts/drafts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe as __mergedSuite, afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { assignReviewClasses } from "./branch-review-closure.js";
import { alignBlocks } from "./document-difference.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { createDraftReviewIdentity } from "./draft-review-identity.js";
import { computeDraftReviewOperations } from "./draft-review-operations.js";
import {
  captureUpdate,
  cloneDoc,
  codec,
  createDoc,
  createDraftReviewFixture,
  model,
  spanTextRange,
  type TextEditRow,
} from "./draft-review-test-fixture.js";
import {
  asPhysicalSourceUpdateIds,
  asSourceUpdateIds,
  type DraftReviewOperationInternal,
} from "./draft-review-types.js";
import { draftItemKey } from "./draft-tree-payload.js";
import { createSemanticProvenanceWriter, PROVENANCE_TARGETS_TYPE } from "./provenance.js";

__mergedSuite("branch-review-closure.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/branch-review-closure.test.ts.
  function op(
    id: string,
    sourceUpdateIds: number[],
    closureUpdateIds = sourceUpdateIds,
  ): Omit<DraftReviewOperationInternal, "closureClassId"> {
    return {
      operationId: id,
      sourceUpdateIds: asSourceUpdateIds(sourceUpdateIds),
      closureUpdateIds: asPhysicalSourceUpdateIds(closureUpdateIds),
      kind: "agent",
      classification: "addition",
    };
  }

  function hunk(id: string, operationIds: string[]): ReviewHunk {
    return {
      kind: "block",
      hunkId: id,
      operationIds,
      anchor: { relStart: "0", relEnd: "0" },
    };
  }

  __mergedSuite("assignReviewClasses", () => {
    it.each([
      false,
      true,
    ])("fresh writer clients separate only independent locations (inside AI: %s)", (insideAi) => {
      const base = textDoc("Alpha remains. Beta remains. Gamma remains.");
      const draft = new Y.Doc({ gc: false });
      Y.applyUpdate(draft, Y.encodeStateAsUpdate(base));
      const updates: Array<{
        id: number;
        updateData: Uint8Array;
      }> = [];
      const record = (id: number, client: number, edit: () => void) => {
        draft.clientID = client;
        const listener = (updateData: Uint8Array) => updates.push({ id, updateData });
        draft.on("update", listener);
        edit();
        draft.off("update", listener);
      };
      const text = draft.getText("chapter");
      record(1, 50001, () => text.insert(5, " green serpent"));
      record(2, 50002, () => text.insert(text.toString().indexOf("serpent") + 2, "WRITERBIT"));
      record(3, 50003, () =>
        text.insert(text.toString().indexOf(insideAi ? "green" : "Beta") + 2, "GOLDPLAIN"),
      );
      const operations = assignReviewClasses({
        operations: [op("ai", [1]), op("writer-a", [2]), op("writer-b", [3])],
        hunks: [],
        updates,
      });
      expect(operations[0]?.closureClassId).toBe(operations[1]?.closureClassId);
      if (insideAi) {
        expect(operations[2]?.closureClassId).toBe(operations[0]?.closureClassId);
      } else {
        expect(operations[2]?.closureClassId).not.toBe(operations[0]?.closureClassId);
        const published = new Y.Doc({ gc: false });
        Y.applyUpdate(published, Y.encodeStateAsUpdate(base));
        const selected = operations[0]?.closureUpdateIds ?? [];
        for (const update of updates.filter((row) => selected.some((id) => id === row.id)))
          Y.applyUpdate(published, update.updateData);
        expect(published.getText("chapter").toString()).toContain("WRITERBIT");
        expect(published.getText("chapter").toString()).not.toContain("GOLDPLAIN");
        expect(published.store.pendingStructs).toBeNull();
        const independent = new Y.Doc({ gc: false });
        Y.applyUpdate(independent, Y.encodeStateAsUpdate(base));
        const elsewhere = updates[2];
        if (!elsewhere) throw new Error("missing writer delta");
        Y.applyUpdate(independent, elsewhere.updateData);
        expect(independent.getText("chapter").toString()).toContain("GOLDPLAIN");
        expect(independent.getText("chapter").toString()).not.toContain("WRITERBIT");
        expect(independent.store.pendingStructs).toBeNull();
        independent.destroy();
        published.destroy();
      }
      draft.destroy();
      base.destroy();
    });
    it("does not join independent delta edits through tombstones already present on live", () => {
      const base = textDoc("Old base text. Alpha. Beta.");
      base.getText("chapter").delete(0, 14);
      const baseDeletedRanges = Y.decodeUpdate(Y.encodeStateAsUpdate(base)).ds.clients;
      const updates = ["Alpha", "Beta"].map((find, index) => {
        const peer = new Y.Doc({ gc: false });
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(base));
        const before = Y.encodeStateVector(peer);
        peer.getText("chapter").insert(peer.getText("chapter").toString().indexOf(find), "New ");
        const updateData = Y.encodeStateAsUpdate(peer, before);
        peer.destroy();
        return { id: index + 1, updateData };
      });
      const operations = assignReviewClasses({
        operations: [op("1", [1]), op("2", [2])],
        hunks: [hunk("h1", ["1"]), hunk("h2", ["2"])],
        updates,
        baseDeletedRanges: [...baseDeletedRanges].flatMap(([client, ranges]) =>
          ranges.map((range) => ({ client, clock: range.clock, length: range.len })),
        ),
      });
      expect(operations.map((operation) => operation.closureClassId)).toEqual([
        expectedClass("1"),
        expectedClass("2"),
      ]);
      base.destroy();
    });
    it("joins operations whose review closures share a physical row", () => {
      const operations = assignReviewClasses({
        operations: [op("a", [1], [1, 2]), op("b", [2], [2])],
        hunks: [hunk("h1", ["a"]), hunk("h2", ["b"])],
      });
      expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
        new Set([expectedClass("a", "b")]),
      );
      expect(operations.map((operation) => operation.sourceUpdateIds)).toEqual([[1], [2]]);
      expect(operations.map((operation) => operation.closureUpdateIds)).toEqual([
        [1, 2],
        [1, 2],
      ]);
    });
    it("does not join operations only because one Apply source set contains the other", () => {
      const operations = assignReviewClasses({
        operations: [op("a", [1], [1]), op("b", [1, 2], [2])],
        hunks: [hunk("h1", ["a"]), hunk("h2", ["b"])],
      });
      expect(operations.map((operation) => operation.closureClassId)).toEqual([
        expectedClass("a"),
        expectedClass("b"),
      ]);
    });
    it("joins operations that share a visible hunk", () => {
      const operations = assignReviewClasses({
        operations: [op("a", [1]), op("b", [2])],
        hunks: [hunk("h1", ["a", "b"])],
      });
      expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
        new Set([expectedClass("a", "b")]),
      );
      expect(operations.map((operation) => operation.closureUpdateIds)).toEqual([
        [1, 2],
        [1, 2],
      ]);
    });
    it.each([
      {
        name: "an AI insert anchored to an earlier AI insert in a different hunk",
        build: () => {
          const doc = textDoc("The cultivator crossed the pass.");
          const first = capture(doc, () => doc.getText("chapter").insert(14, "swiftly "));
          const second = capture(doc, () => doc.getText("chapter").insert(22, "and silently "));
          return { doc, updates: [first, second] };
        },
      },
      {
        name: "a later turn deleting earlier-turn text",
        build: () => {
          const doc = textDoc("The cultivator crossed the pass.");
          const first = capture(doc, () => doc.getText("chapter").insert(14, "swiftly "));
          const second = capture(doc, () => doc.getText("chapter").delete(14, 8));
          return { doc, updates: [first, second] };
        },
      },
      {
        name: "a block created by one turn and edited by another",
        build: () => {
          const doc = new Y.Doc({ gc: false });
          const fragment = doc.getXmlFragment("prosemirror");
          const first = capture(doc, () => {
            const paragraph = new Y.XmlElement("paragraph");
            const text = new Y.XmlText();
            text.insert(0, "New realm breakthrough.");
            paragraph.insert(0, [text]);
            fragment.insert(0, [paragraph]);
          });
          const second = capture(doc, () => {
            const paragraph = fragment.get(0) as Y.XmlElement;
            const text = paragraph.get(0) as Y.XmlText;
            text.insert(9, "sudden ");
          });
          return { doc, updates: [first, second] };
        },
      },
      {
        name: "a writer edit inside AI text",
        build: () => {
          const doc = textDoc("Chapter opening.");
          const first = capture(doc, () => doc.getText("chapter").insert(8, "AI-generated "));
          const second = capture(doc, () => doc.getText("chapter").insert(11, "writer-polished "));
          return { doc, updates: [first, second] };
        },
      },
    ])("joins $name", ({ build }) => {
      const { doc, updates } = build();
      try {
        const operations = assignReviewClasses({
          operations: [op("1", [1]), op("2", [2])],
          hunks: [hunk("h1", ["1"]), hunk("h2", ["2"])],
          updates: updates.map((update, index) => ({ id: index + 1, updateData: update })),
        });
        expect(operations.map((operation) => operation.closureClassId)).toEqual([
          expectedClass("1", "2"),
          expectedClass("1", "2"),
        ]);
      } finally {
        doc.destroy();
      }
    });
    it("collapses the synthetic three-turn chapter rewrite into one group", () => {
      const authority = textDoc(
        "At dawn, Lin climbed the mountain. At noon, he entered the sect. At dusk, he faced the elder.",
      );
      try {
        const turn1 = editFromFreshPeer(authority, (text) => {
          text.insert(9, "weary ");
          text.insert(59, "hidden ");
        });
        const turn2 = editFromFreshPeer(authority, (text) => {
          const weary = text.toString().indexOf("weary");
          text.delete(weary, "weary".length);
          text.insert(weary, "bloodied");
        });
        const turn3 = editFromFreshPeer(authority, (text) => {
          const bloodied = text.toString().indexOf("bloodied") + "bloodied".length;
          text.insert(bloodied, " but unbowed");
        });
        const operations = assignReviewClasses({
          operations: [op("1", [1]), op("2", [2]), op("3", [3])],
          hunks: [hunk("turn-1", ["1"]), hunk("turn-2", ["2"]), hunk("turn-3", ["3"])],
          updates: [turn1, turn2, turn3].map((update, index) => ({
            id: index + 1,
            updateData: update,
          })),
        });
        expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
          new Set([expectedClass("1", "2", "3")]),
        );
      } finally {
        authority.destroy();
      }
    });
    it("carries an invisible supplier row into the visible operation's row set", () => {
      const doc = textDoc("Base.");
      try {
        const supplier = capture(doc, () => doc.getText("chapter").insert(5, " hidden"));
        const visible = capture(doc, () => doc.getText("chapter").insert(12, " visible"));
        const [operation] = assignReviewClasses({
          operations: [op("2", [2])],
          hunks: [hunk("visible", ["2"])],
          updates: [
            { id: 1, updateData: supplier },
            { id: 2, updateData: visible },
          ],
        });
        expect(operation?.closureUpdateIds).toEqual([1, 2]);
      } finally {
        doc.destroy();
      }
    });
  });

  function textDoc(initial: string): Y.Doc {
    const doc = new Y.Doc({ gc: false });
    doc.getText("chapter").insert(0, initial);
    return doc;
  }

  function capture(doc: Y.Doc, mutate: () => void): Uint8Array {
    const before = Y.encodeStateVector(doc);
    mutate();
    return Y.encodeStateAsUpdate(doc, before);
  }

  function editFromFreshPeer(authority: Y.Doc, mutate: (text: Y.Text) => void): Uint8Array {
    const peer = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(authority));
      const update = capture(peer, () => mutate(peer.getText("chapter")));
      Y.applyUpdate(authority, update);
      return update;
    } finally {
      peer.destroy();
    }
  }

  it("uses bounded opaque class IDs stable under member ordering", () => {
    const operations = Array.from({ length: 1000 }, (_, i) => op(`operation-${i}`, [i]));
    const hunks = [
      hunk(
        "shared",
        operations.map((op) => op.operationId),
      ),
    ];
    const forward = assignReviewClasses({ operations, hunks });
    const reversed = assignReviewClasses({ operations: [...operations].reverse(), hunks });
    expect(forward[0].closureClassId).toMatch(/^closure:v1:[A-Za-z0-9_-]{43}$/);
    expect(forward[0].closureClassId).toBe(reversed[0].closureClassId);
  });

  it("keeps a class's id when a re-fork gives its members new row ids but the same edit parts", () => {
    const part = (id: string, partKey: string) => ({ ...op(id, [Number(id)]), partKey });
    const first = assignReviewClasses({
      operations: [part("20", "edit-a:0"), part("21", "edit-a:1")],
      hunks: [hunk("h", ["20", "21"])],
    });
    const refork = assignReviewClasses({
      operations: [part("31", "edit-a:1"), part("30", "edit-a:0")],
      hunks: [hunk("h", ["30", "31"])],
    });
    expect(refork[0].closureClassId).toBe(first[0].closureClassId);
    const independent = assignReviewClasses({
      operations: [part("20", "edit-a:0"), part("21", "edit-a:1")],
      hunks: [hunk("first", ["20"]), hunk("second", ["21"])],
    });
    expect(independent[0].partKey).not.toBe(independent[1].partKey);
    expect(independent[0].closureClassId).not.toBe(independent[1].closureClassId);
    // Another edit with the same text is another change.
    const other = assignReviewClasses({
      operations: [part("40", "edit-b:0"), part("41", "edit-a:1")],
      hunks: [hunk("h", ["40", "41"])],
    });
    expect(other[0].closureClassId).not.toBe(first[0].closureClassId);
  });

  function expectedClass(...ids: string[]): string {
    return `closure:v1:${createHash("sha256").update(JSON.stringify(ids)).digest("base64url")}`;
  }
});

__mergedSuite("draft-review-attribution.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/draft-review-attribution.test.ts.
  type SyntheticHunk = Parameters<typeof computeDraftReviewOperations>[0]["hunks"][number];

  function syntheticHunk(hunkId: string, raw: SyntheticHunk["raw"]): SyntheticHunk {
    return {
      raw,
      review: {
        kind: "text",
        hunkId,
        operationIds: [],
        spans: [],
        anchor: { relStart: "", relEnd: "" },
        ...(raw.deletedText ? { deletedText: raw.deletedText } : {}),
      },
    };
  }

  const peers: Y.Doc[] = [];

  const fixtures: ReturnType<typeof createDraftReviewFixture>[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.destroy();
    for (const peer of peers.splice(0)) peer.destroy();
  });

  function setup(markdown: string, rows?: readonly TextEditRow[]) {
    const fixture = createDraftReviewFixture(markdown, rows);
    fixtures.push(fixture);
    return fixture;
  }

  __mergedSuite("draft review attribution", () => {
    it("carries full inserted text on every attributed hunk of a multi-pair replacement", () => {
      const fixture = setup(
        "Rain threaded the broken archway, and the river carried the last light of evening toward the sea.",
        [{ id: 20, actorTurnId: "turn-replace", edits: [[0, 18, 32, "weathered gate"]] }],
      );
      const result = computeDraftReviewHunks(fixture.input);
      expect(result.hunks).toEqual([
        expect.objectContaining({
          kind: "text",
          deletedText: "broken",
          insertedText: "weathered",
          operationIds: ["20"],
        }),
        expect.objectContaining({
          kind: "text",
          deletedText: "archway",
          insertedText: "gate",
          operationIds: ["20"],
        }),
      ]);
    });
    it("attributes deleted live text to the row whose delete set covers it", () => {
      const fixture = setup(
        "Alpha sword remains with enough unchanged surrounding text for inline review density.",
        [{ id: 21, actorTurnId: "turn-delete", edits: [[0, 6, 12, ""]] }],
      );
      const result = computeDraftReviewHunks(fixture.input);
      expect(result.hunks).toEqual([
        expect.objectContaining({ operationIds: ["21"], deletedText: "sword " }),
      ]);
    });
    it("keeps one row that genuinely deletes two regions linked to both hunks", () => {
      const fixture = setup(
        [
          "Alpha target remains with enough unchanged surrounding text for attribution.",
          "Beta target remains with enough unchanged surrounding text for attribution.",
          "Gamma stays unchanged with enough surrounding text for attribution.",
        ].join("\n\n"),
        [
          {
            id: 171,
            actorTurnId: "turn-two-deletions",
            edits: [
              [0, 6, 13, ""],
              [1, 5, 12, ""],
            ],
          },
        ],
      );
      const result = computeDraftReviewHunks(fixture.input);
      expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["171"], ["171"]]);
      expect(result.operations).toEqual([
        expect.objectContaining({
          operationId: "171",
          classification: "removal",
          beforeExcerpt: "target",
          sourceUpdateIds: [171],
          closureUpdateIds: [171],
          actorTurnId: "turn-two-deletions",
          kind: "agent",
        }),
      ]);
    });
    it("keeps an unattributed removal beside an attributed insertion and reports the gap", () => {
      const fixture = setup("Alpha stays.");
      const { live, draft } = fixture;
      const block = model.getBlocks(toDocHandle(draft))[0];
      const updateData = captureUpdate(draft, () =>
        model.applyTextEdit(toDocHandle(draft), block, { from: 0, to: 0 }, "New "),
      );
      const insertedRanges = Y.decodeUpdate(updateData).structs.map((item) => ({
        ...item.id,
        length: item.length,
      }));
      const result = computeDraftReviewOperations({
        baseDoc: live,
        updates: [{ id: 990, actorTurnId: "turn", updateData }],
        hunks: [
          syntheticHunk("test", {
            insertedRanges,
            deletedRanges: [{ client: 1, clock: 3, length: 5 }],
            insertedText: "New ",
            deletedText: "Alpha",
          }),
        ],
      });
      expect(result.hunks[0]).toMatchObject({
        deletedText: "Alpha",
        deletedSpans: [],
        unclassified: true,
      });
      expect(result.diagnostics).toEqual([{ code: "unattributed_hunk", hunkId: "test" }]);
      expect(result.operations[0]).toMatchObject({ canApplyOrDiscard: false });
    });
    it("keeps the full partly attributed removal rather than only its known author spans", () => {
      const fixture = setup("Alpha stays.");
      const { live, draft } = fixture;
      const block = model.getBlocks(toDocHandle(draft))[0];
      const updateData = captureUpdate(draft, () =>
        model.applyTextEdit(toDocHandle(draft), block, { from: 0, to: 5 }, ""),
      );
      const known = [...Y.decodeUpdate(updateData).ds.clients].flatMap(([client, ranges]) =>
        ranges.map((range) => ({ client, clock: range.clock, length: range.len })),
      );
      const result = computeDraftReviewOperations({
        baseDoc: live,
        updates: [{ id: 991, actorTurnId: "turn", updateData }],
        hunks: [
          syntheticHunk("partial", {
            insertedRanges: [],
            deletedRanges: [...known, { client: Number.MAX_SAFE_INTEGER, clock: 3, length: 1 }],
            insertedText: "",
            deletedText: "Alpha?",
          }),
        ],
      });
      expect(result.hunks[0]).toMatchObject({
        deletedText: "Alpha?",
        deletedSpans: [],
        unclassified: true,
      });
      expect(result.operations[0]).toMatchObject({ canApplyOrDiscard: false });
      expect(result.diagnostics).toEqual([{ code: "unattributed_hunk", hunkId: "partial" }]);
    });
    it.each([
      "removal",
      "insertion",
    ] as const)("retains a wholly unattributed %s without inventing an author", (kind) => {
      const live = createDoc("Alpha stays.");
      try {
        const result = computeDraftReviewOperations({
          baseDoc: live,
          updates: [],
          hunks: [
            syntheticHunk("test", {
              insertedRanges: kind === "insertion" ? [{ client: 1, clock: 3, length: 5 }] : [],
              deletedRanges: kind === "removal" ? [{ client: 1, clock: 3, length: 5 }] : [],
              insertedText: kind === "insertion" ? "Alpha" : "",
              deletedText: kind === "removal" ? "Alpha" : "",
            }),
          ],
        });
        expect(result.hunks).toHaveLength(1);
        expect(result.hunks[0]).toMatchObject({
          operationIds: [],
          unclassified: true,
          spans: [],
        });
        if (kind === "removal")
          expect(result.hunks[0]).toMatchObject({
            deletedText: "Alpha",
            deletedSpans: [],
          });
        else expect(result.hunks[0]).toMatchObject({ insertedText: "Alpha" });
        expect(result.operations).toEqual([]);
        expect(result.diagnostics).toEqual([{ code: "unattributed_hunk", hunkId: "test" }]);
      } finally {
        live.destroy();
      }
    });
    it("covers adjacent cross-chat sentence removal and replacement without attribution gaps", () => {
      const fixture = setup(
        "Su Yin said nothing. It was a very tense moment for everyone present.\n\nEnd.",
      );
      const { draft } = fixture;
      const edits = [
        [" It was a very tense moment for everyone present.", ""],
        ["Su Yin said nothing.", "Su Yin said nothing, but her sleeve hid a drawn talisman."],
      ];
      const updates = edits.map(([find, replacement], index) => ({
        id: 901 + index,
        actorTurnId: `chat-${index}`,
        updateData: captureUpdate(draft, () => {
          const [block] = model.getBlocks(toDocHandle(draft));
          const text = model.getText(block);
          const from = text.indexOf(find);
          model.applyBlockReplacement(
            toDocHandle(draft),
            block,
            codec.parse(text.slice(0, from) + replacement + text.slice(from + find.length))
              .blocks[0],
          );
        }),
      }));
      const result = computeDraftReviewHunks({
        ...fixture.input,
        draftUpdates: updates,
      });
      expect(
        result.hunks
          .filter((h) => h.kind === "text")
          .map((h) => h.deletedText ?? "")
          .join(""),
      ).toBe(edits[0][0]);
      expect(result.hunks.find((h) => h.kind === "text" && h.deletedText)?.operationIds).toEqual([
        "901",
      ]);
      expect(result.hunks.flatMap((h) => h.operationIds)).toEqual(
        expect.arrayContaining(["901", "902"]),
      );
      for (const hunk of result.hunks) {
        if (hunk.kind !== "text" || !hunk.deletedText) continue;
        expect(hunk.deletedSpans?.reduce((length, span) => length + span.to - span.from, 0)).toBe(
          hunk.deletedText.length,
        );
      }
    });
    it("covers the full difference after consecutive cumulative paragraph deletions", () => {
      const paragraphs = ["Alpha removed.", "Beta removed.", "Gamma removed."];
      const fixture = setup([...paragraphs, "Tail remains."].join("\n\n"));
      const { draft } = fixture;
      const updates = paragraphs.map((_, index) => ({
        id: 175 + index,
        actorTurnId: `turn-${index}`,
        updateData: captureUpdate(draft, () => {
          const [first] = model.getBlocks(toDocHandle(draft));
          model.deleteBlock(toDocHandle(draft), first);
        }),
      }));
      const result = computeDraftReviewHunks({
        ...fixture.input,
        draftUpdates: updates,
      });
      // The union must account for every removed region, not just the first delete set.
      expect(
        result.hunks.map((hunk) =>
          hunk.kind === "text" ? hunk.deletedText : hunk.deletedBlock?.display,
        ),
      ).toEqual(paragraphs);
      expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["175"], ["176"], ["177"]]);
    });
    it("preserves the full diff union across mixed insertions and cumulative removals", () => {
      const removed = ["Alpha removed.", "Beta removed.", "Gamma removed."];
      const fixture = setup([...removed, "ABC remains."].join("\n\n"));
      const { draft } = fixture;
      const updates = removed.map((_, index) => ({
        id: 185 + index,
        actorTurnId: `turn-${index}`,
        updateData: captureUpdate(draft, () => {
          const [first] = model.getBlocks(toDocHandle(draft));
          model.deleteBlock(toDocHandle(draft), first);
        }),
      }));
      const [tail] = model.getBlocks(toDocHandle(draft));
      updates.push({
        id: 188,
        actorTurnId: "rewrite",
        updateData: captureUpdate(draft, () =>
          model.applyTextEdit(toDocHandle(draft), tail, { from: 0, to: 3 }, "XYZ"),
        ),
      });
      const result = computeDraftReviewHunks({
        ...fixture.input,
        draftUpdates: updates,
      });
      const deletionUnion = result.hunks
        .map((hunk) =>
          hunk.kind === "text" ? (hunk.deletedText ?? "") : (hunk.deletedBlock?.display ?? ""),
        )
        .join("");
      const insertionUnion = result.hunks
        .flatMap((hunk) =>
          hunk.kind === "text"
            ? hunk.spans.map((span) => {
                const position = Y.createAbsolutePositionFromRelativePosition(
                  Y.decodeRelativePosition(Buffer.from(span.anchorFrom, "base64")),
                  draft,
                );
                if (!position || !(position.type instanceof Y.XmlText))
                  throw new Error("expected attributed text span");
                const range = spanTextRange(draft, span);
                return position.type.toString().slice(range.from, range.to);
              })
            : [hunk.insertedBlock?.display ?? ""],
        )
        .join("");
      // Independent fixture oracle for the entire difference, not merely visible operations.
      expect(deletionUnion).toBe(`${removed.join("")}ABC`);
      expect(insertionUnion).toBe("XYZ");
      expect(result.hunks.every((hunk) => hunk.operationIds.length > 0)).toBe(true);
      expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
        new Set(["185", "186", "187", "188"]),
      );
    });
    it("keeps writer insertions inside AI prose author-separable", () => {
      const fixture = setup("Old sentence. Tail unchanged for alignment.", [
        { id: 178, actorTurnId: "ai", edits: [[0, 0, 13, "New AI sentence."]] },
        { id: 179, actorTurnId: null, actorUserId: "writer", edits: [[0, 6, 6, "careful "]] },
      ]);
      const result = computeDraftReviewHunks(fixture.input);
      expect(result.hunks.some((hunk) => hunk.operationIds.length === 2)).toBe(true);
      expect(result.hunks.every((hunk) => !hunk.mergeArtifact)).toBe(true);
    });
    it("does not flag adjacent edits with only one removed insertion boundary", () => {
      const fixture = setup("Alpha sword remains with enough unchanged surrounding text.", [
        { id: 178, actorTurnId: "ai", edits: [[0, 11, 11, " AI"]] },
        { id: 179, actorTurnId: null, actorUserId: "writer", edits: [[0, 6, 11, ""]] },
      ]);
      const result = computeDraftReviewHunks(fixture.input);
      expect(result.hunks.every((hunk) => !hunk.mergeArtifact)).toBe(true);
    });
    it.each([
      { offset: 1, mergeArtifact: true },
      { offset: 5, mergeArtifact: false },
    ])("flags only writer typing inside text concurrently removed by AI ($offset)", ({
      offset,
      mergeArtifact,
    }) => {
      const fixture = setup("Old sentence. Tail unchanged for alignment.");
      const { live, draft } = fixture;
      const peer = cloneDoc(live);
      peers.push(peer);
      peer.clientID = 3;
      const [aiBlock] = model.getBlocks(toDocHandle(draft));
      const [writerBlock] = model.getBlocks(toDocHandle(peer));
      const ai = captureUpdate(draft, () =>
        model.applyTextEdit(toDocHandle(draft), aiBlock, { from: 0, to: 13 }, "New AI sentence."),
      );
      const writer = captureUpdate(peer, () =>
        model.applyTextEdit(
          toDocHandle(peer),
          writerBlock,
          { from: offset, to: offset },
          "careful ",
        ),
      );
      Y.applyUpdate(draft, writer);
      const result = computeDraftReviewHunks({
        ...fixture.input,
        draftUpdates: [
          { id: 178, actorTurnId: "ai", updateData: ai },
          { id: 179, actorTurnId: null, actorUserId: "writer", updateData: writer },
        ],
      });
      expect(result.hunks.some((hunk) => hunk.mergeArtifact)).toBe(mergeArtifact);
    });
    it("attributes adjacent deleted spans independently of inserted-text owners", () => {
      const fixture = setup(
        "Alpha sword blade remains with plenty of unchanged surrounding text.",
        [
          { id: 178, actorTurnId: "ai", edits: [[0, 6, 12, ""]] },
          { id: 179, actorTurnId: null, actorUserId: "writer", edits: [[0, 6, 12, "new "]] },
        ],
      );
      const result = computeDraftReviewHunks(fixture.input);
      const hunk = result.hunks[0];
      expect(hunk).toMatchObject({
        deletedText: "sword blade",
        deletedSpans: [
          { from: 0, to: 6, deletedBy: "agent" },
          { from: 6, to: 11, deletedBy: "writer" },
        ],
      });
    });
    it("keeps source writer rows distinct inside one clock-prefix class", () => {
      const fixture = setup("Alpha. Tail text for a writer edit cluster.", [
        { id: 181, actorTurnId: null, actorUserId: "user-a", edits: [[0, 5, 5, " writer"]] },
        { id: 182, actorTurnId: null, actorUserId: "user-a", edits: [[0, 12, 12, " careful"]] },
      ]);
      const result = computeDraftReviewHunks(fixture.input);
      expect(result.operations.map((op) => op.sourceUpdateIds)).toEqual([[181], [182]]);
      expect(new Set(result.operations.map((op) => op.closureClassId)).size).toBe(1);
      expect(
        result.operations.every((op) => op.kind === "writer" && op.actorUserId === "user-a"),
      ).toBe(true);
    });
    it("keeps mixed agent and writer rows in one block as separate operations", () => {
      const fixture = setup(
        "Alpha target remains with enough unchanged surrounding text for attribution.",
        [
          { id: 211, actorTurnId: "turn-agent", edits: [[0, 6, 12, "agent"]] },
          { id: 212, actorTurnId: null, actorUserId: "user-a", edits: [[0, 11, 11, " writer"]] },
        ],
      );
      const result = computeDraftReviewHunks(fixture.input);
      expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
        new Set(["211", "212"]),
      );
      expect(result.operations).toEqual([
        expect.objectContaining({
          operationId: "211",
          classification: "rewrite",
          beforeExcerpt: "targe",
          afterExcerpt: "agen",
          sourceUpdateIds: [211],
          closureUpdateIds: [211, 212],
          actorTurnId: "turn-agent",
          kind: "agent",
        }),
        expect.objectContaining({
          operationId: "212",
          classification: "addition",
          afterExcerpt: "writer",
          sourceUpdateIds: [212],
          closureUpdateIds: [211, 212],
          actorUserId: "user-a",
          kind: "writer",
        }),
      ]);
    });
    it("emits ordered inserted sub-spans with source writer operation identities", () => {
      const fixture = setup("Alpha tail text for mixed insertion span ordering.", [
        { id: 264, actorTurnId: "turn-agent", edits: [[0, 6, 6, "green text"]] },
        { id: 265, actorTurnId: null, actorUserId: "user-a", edits: [[0, 12, 12, "gold "]] },
      ]);
      const { draft } = fixture;
      const result = computeDraftReviewHunks(fixture.input);
      const [hunk] = result.hunks;
      const writerOperation = result.operations.find((operation) => operation.kind === "writer");
      expect(writerOperation?.sourceUpdateIds).toEqual([265]);
      expect(hunk.kind).toBe("text");
      if (hunk.kind !== "text") throw new Error("expected text hunk");
      expect(writerOperation?.operationId).toBe("265");
      expect(hunk.spans.map((span) => span.operationId)).toContain("265");
      const positions = hunk.spans.map((span) => spanTextRange(draft, span));
      expect(
        positions.every(
          (position, index) => index === 0 || positions[index - 1].to <= position.from,
        ),
      ).toBe(true);
      expect(positions.reduce((sum, position) => sum + position.to - position.from, 0)).toBe(
        "green gold text".length,
      );
    });
    it("surfaces writer edits inside unchanged-identity blocks untouched by the agent", () => {
      const fixture = setup(
        [
          "Alpha remains unchanged with enough surrounding text for review attribution.",
          "Beta target remains with enough unchanged surrounding text for agent attribution.",
          "Gamma remains unchanged with enough surrounding text for review attribution.",
          "Delta remains unchanged with enough surrounding text for writer attribution.",
        ].join("\n\n"),
        [
          { id: 241, actorTurnId: "turn-agent", edits: [[1, 11, 11, " agent"]] },
          { id: 242, actorTurnId: null, actorUserId: "user-a", edits: [[3, 5, 5, " writer"]] },
        ],
      );
      const result = computeDraftReviewHunks(fixture.input);
      expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["241"], ["242"]]);
      expect(result.operations).toEqual([
        expect.objectContaining({
          operationId: "241",
          classification: "addition",
          afterExcerpt: "agent",
          sourceUpdateIds: [241],
          closureUpdateIds: [241, 242],
          actorTurnId: "turn-agent",
          kind: "agent",
        }),
        expect.objectContaining({
          operationId: "242",
          classification: "addition",
          afterExcerpt: "writer",
          sourceUpdateIds: [242],
          closureUpdateIds: [241, 242],
          actorUserId: "user-a",
          kind: "writer",
        }),
      ]);
    });
    it("drops opposite block delete/insert pairs from per-operation reject inverses", () => {
      const fixture = setup(
        [
          "Alpha remains unchanged with enough surrounding text for review attribution.",
          "- Placeholder outline beat one should be cut.",
          "- Placeholder outline beat two should be cut.",
          "Omega remains as an anchor after the restored writer block.",
        ].join("\n\n"),
      );
      const { draft } = fixture;
      const [alpha, list] = model.getBlocks(toDocHandle(draft));
      const rewrite = captureUpdate(draft, () =>
        model.applyTextEdit(toDocHandle(draft), alpha, { from: 0, to: 5 }, "Beta"),
      );
      const deleteList = captureUpdate(draft, () => model.deleteBlock(toDocHandle(draft), list));
      const rejectInverseInsert = captureUpdate(draft, () =>
        model.insertBlocks(
          toDocHandle(draft),
          alpha,
          codec.parse(
            "- Placeholder outline beat one should be cut.\n\n- Placeholder outline beat two should be cut.",
          ),
        ),
      );
      const result = computeDraftReviewHunks({
        ...fixture.input,
        draftUpdates: [
          { id: 266, actorTurnId: "turn-rewrite", updateData: rewrite },
          { id: 267, actorTurnId: "turn-delete-list", updateData: deleteList },
          { id: 268, actorTurnId: null, actorUserId: "user-a", updateData: rejectInverseInsert },
        ],
      });
      expect(result.hunks).toHaveLength(1);
      expect(result.hunks[0]).toMatchObject({ kind: "text", operationIds: ["266"] });
      expect(result.operations).toEqual([
        expect.objectContaining({
          operationId: "266",
          classification: "rewrite",
        }),
      ]);
    });
  });
});

__mergedSuite("draft-review-class-replay.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/draft-review-class-replay.test.ts.
  __mergedSuite("draft review class-replay", () => {
    it("fact-carrying structural writes in separate paragraphs replay independently", () => {
      const live = createDoc("Alpha Beta.\n\nDivider.\n\nBlue Silver."),
        draft = cloneDoc(live);
      try {
        const updates = [
          { id: 1, prefix: 6, output: "Gamma Beta." },
          { id: 2, prefix: 5, output: "Gold Silver." },
        ].map(({ id, prefix, output }, index) => {
          const paragraph = index * 2;
          draft.clientID = 900 + id;
          const block = model.getBlocks(toDocHandle(draft))[paragraph];
          const source = model.getVisibleContentLineage(block)[0];
          const replacement = codec.parse(output).blocks[0];
          const before = Y.encodeStateVector(draft);
          const ir: SemanticEditIRV1 = {
            version: 1,
            documentId: "doc",
            inputRevision: "revision" as never,
            scope: [source],
            deleted: [source],
            intent: {
              kind: "mappedEdits",
              edits: [
                {
                  edit: { kind: "block", documentId: "doc", file: "doc.md", block, replacement },
                  outputRuns: [
                    {
                      kind: "fresh",
                      payload: output.slice(0, prefix),
                      output: { from: 0, to: prefix },
                    },
                    {
                      kind: "preserved",
                      source: {
                        ...source,
                        clock: source.clock + prefix,
                        length: output.length - prefix,
                      },
                      output: { from: prefix, to: output.length },
                    },
                  ],
                },
              ],
            },
          };
          const updateData = Y.mergeUpdates(
            captureMutationUpdates(draft, () =>
              draft.transact(() => {
                const previous =
                  paragraph === 0 ? null : model.getBlocks(toDocHandle(draft))[paragraph - 1];
                model.deleteBlock(toDocHandle(draft), block);
                model.insertBlocks(toDocHandle(draft), previous, codec.parse(output));
                createSemanticProvenanceWriter().writeCertifiedFacts(
                  toDocHandle(draft),
                  ir,
                  before,
                );
              }),
            ),
          );
          const structs = Y.decodeUpdate(updateData).structs;
          expect(new Set(structs.map((item) => item.id.client))).toEqual(new Set([900 + id]));
          const facts = structs.filter(
            (item) =>
              item instanceof Y.Item && (item.parent as unknown) === PROVENANCE_TARGETS_TYPE,
          ) as Y.Item[];
          expect(facts.length).toBeGreaterThan(0);
          for (const fact of facts) {
            expect(fact.origin).toBeNull();
            expect(fact.rightOrigin).toBeNull();
          }
          return { id, actorTurnId: `turn-${id}`, updateData };
        });
        const preview = computeDraftReviewHunks({
          liveDoc: live,
          draftDoc: draft,
          model: model,
          draftUpdates: updates,
        });
        expect(preview.operations).toHaveLength(2);
        expect(new Set(preview.operations.map((op) => op.closureClassId)).size).toBe(2);
        for (const [index, row] of updates.entries()) {
          const replay = cloneDoc(live);
          try {
            Y.applyUpdate(replay, row.updateData);
            expect(
              model.getBlocks(toDocHandle(replay)).map((block) => model.getText(block)),
            ).toEqual(
              index === 0
                ? ["Gamma Beta.", "Divider.", "Blue Silver."]
                : ["Alpha Beta.", "Divider.", "Gold Silver."],
            );
            expect(replay.store.pendingStructs).toBeNull();
          } finally {
            replay.destroy();
          }
        }
      } finally {
        live.destroy();
        draft.destroy();
      }
    });
    it.each([
      { label: "shared client with adjacent rewrite", adjacentRewrite: true, freshPeers: false },
      {
        label: "fresh chat peers (reported operation 72)",
        adjacentRewrite: false,
        freshPeers: true,
      },
    ])("publishes every class and its preview complement ($label)", ({
      adjacentRewrite,
      freshPeers,
    }) => {
      const base = [
        "Elder Mo raised his hand, and the courtyard fell silent.",
        "Su Yin said nothing. It was a very tense moment for everyone present.",
        "The outer disciples stepped back, and even the inner disciples looked away.",
        "The mountain stayed still.",
        "The river kept flowing.",
      ].join("\n\n");
      const live = createDoc(base);
      const draft = cloneDoc(live);
      const edits = [
        { id: 69, block: 0, find: "his", replacement: "" },
        {
          id: 71,
          block: 1,
          find: " It was a very tense moment for everyone present.",
          replacement: "",
        },
        {
          id: 72,
          block: 0,
          find: "fell silent.",
          replacement: "fell silent. Lin Feng felt the qi coil.",
        },
        { id: 74, block: 3, find: "stayed still.", replacement: "stayed still. A bell rang." },
        { id: 75, block: 2, find: "stepped back", replacement: "fell back to their knees" },
      ];
      if (adjacentRewrite)
        edits.push({
          id: 77,
          block: 1,
          find: "Su Yin said nothing.",
          replacement: "Su Yin said nothing, but her sleeve hid a drawn talisman.",
        });
      const updates = edits.map((edit) => ({
        id: edit.id,
        actorTurnId: `turn-${edit.id}`,
        updateData: captureUpdate(draft, () => {
          if (freshPeers) draft.clientID = 10 + edit.id;
          const block = model.getBlocks(toDocHandle(draft))[edit.block];
          const from = model.getText(block).indexOf(edit.find);
          model.applyBlockReplacement(
            toDocHandle(draft),
            block,
            codec.parse(model.getText(block).replace(edit.find, edit.replacement)).blocks[0],
          );
          expect(from).toBeGreaterThanOrEqual(0);
        }),
      }));
      // A fresh peer's transaction delta has no cumulative branch deletes and
      // stays independently selectable, unlike the shared client's clock prefix.
      const independent = { id: 76, block: 4, find: "flowing", replacement: "flowing north" };
      edits.push(independent);
      const peer = cloneDoc(draft);
      peer.clientID = 3;
      let delta: Uint8Array | undefined;
      peer.on("update", (update) => {
        delta = update;
      });
      const river = model.getBlocks(toDocHandle(peer))[4];
      model.applyTextEdit(toDocHandle(peer), river, { from: 22, to: 22 }, " north");
      if (!delta) throw new Error("missing independent update");
      Y.applyUpdate(draft, delta);
      updates.push({ id: 76, actorTurnId: "turn-76", updateData: delta });
      peer.destroy();
      const preview = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: draft,
        model: model,
        draftUpdates: updates,
      });
      const classes = new Set(preview.operations.map((op) => op.closureClassId));
      expect(classes.size).toBeGreaterThan(1);
      // Exercise the reported later insertion first, then every other class.
      const reportedClass = preview.operations.find(
        (op) => op.operationId === "72",
      )?.closureClassId;
      for (const classId of [...classes].sort(
        (a, b) => Number(b === reportedClass) - Number(a === reportedClass),
      )) {
        const selected = preview.operations.filter((op) => op.closureClassId === classId);
        const ids = new Set(selected.map((op) => op.operationId));
        const rowIds = new Set<number>(selected.flatMap((op) => op.closureUpdateIds));
        const applied = cloneDoc(live);
        applied.clientID = 4;
        for (const row of updates.filter((row) => rowIds.has(row.id)))
          Y.applyUpdate(applied, row.updateData);
        let expected = base;
        for (const edit of edits.filter((edit) => ids.has(String(edit.id))))
          expected = expected.replace(edit.find, edit.replacement);
        expect(
          model
            .getBlocks(toDocHandle(applied))
            .map((block) => model.getText(block))
            .join("\n\n"),
          classId,
        ).toBe(expected);
        const remaining = computeDraftReviewHunks({
          liveDoc: applied,
          draftDoc: draft,
          model: model,
          draftUpdates: updates.filter((row) => !rowIds.has(row.id)),
        });
        const signature = (hunks: typeof preview.hunks) =>
          hunks.map((hunk) => ({
            ids: hunk.operationIds,
            deleted: hunk.kind === "text" ? hunk.deletedText : hunk.deletedBlock?.display,
            inserted:
              hunk.kind === "text"
                ? hunk.spans
                    .map((span) => {
                      const position = Y.createAbsolutePositionFromRelativePosition(
                        Y.decodeRelativePosition(Buffer.from(span.anchorFrom, "base64")),
                        draft,
                      );
                      if (!position || !(position.type instanceof Y.XmlText))
                        throw new Error("missing span");
                      const range = spanTextRange(draft, span);
                      return position.type.toString().slice(range.from, range.to);
                    })
                    .join("")
                : hunk.insertedBlock?.display,
          }));
        const published = computeDraftReviewHunks({
          liveDoc: live,
          draftDoc: applied,
          model: model,
          draftUpdates: updates.filter((row) => rowIds.has(row.id)),
        });
        expect(signature(published.hunks), classId).toEqual(
          signature(preview.hunks.filter((hunk) => hunk.operationIds.some((id) => ids.has(id)))),
        );
        expect(signature(remaining.hunks), classId).toEqual(
          signature(preview.hunks.filter((hunk) => !hunk.operationIds.some((id) => ids.has(id)))),
        );
        applied.destroy();
      }
      draft.destroy();
      live.destroy();
    });
  });
});

__mergedSuite("draft-review-hunks.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/draft-review-hunks.test.ts.
  __mergedSuite("draft review hunks", () => {
    it("uses a generic image label rather than exposing a stored source identity", () => {
      const live = createDoc("Anchor.");
      const draft = cloneDoc(live);
      const image = new Y.XmlElement("image");
      image.setAttribute("src", "asset:00000000-0000-4000-8000-000000000712");
      const update = captureUpdate(draft, () => {
        const fragment = draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
        fragment.insert(fragment.length, [image]);
      });
      try {
        const review = computeDraftReviewHunks({
          liveDoc: live,
          draftDoc: draft,
          model: model,
          draftUpdates: [{ id: 60, actorTurnId: "turn-image", updateData: update }],
        });
        expect(review.hunks).toContainEqual(
          expect.objectContaining({
            kind: "block",
            insertedBlock: { type: "image", display: "Image" },
          }),
        );
        expect(JSON.stringify(review)).not.toContain("asset:");
      } finally {
        draft.destroy();
        live.destroy();
      }
    });
  });

  __mergedSuite("block alignment", () => {
    it("retains the first duplicate surviving anchor under the LCS tie rule", () => {
      const result = alignBlocks(
        [{ id: "a" }, { id: "b" }],
        [
          { id: "b", text: "first" },
          { id: "b", text: "last" },
        ],
      );
      expect(result.map((entry) => entry.kind)).toEqual(["delete", "equal", "insert"]);
      expect(result[1]).toMatchObject({ draft: { text: "first" } });
    });
  });
});

__mergedSuite("draft-review-identity.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/draft-review-identity.test.ts.
  const WORK = "00000000-0000-4000-8000-000000000001" as WorkId;

  const D1 = "00000000-0000-4000-8000-0000000000d1" as DraftId;

  const D2 = "00000000-0000-4000-8000-0000000000d2" as DraftId;

  const DOC = "00000000-0000-4000-8000-0000000000aa" as DocumentId;

  it("resolves a key inside the draft it validated, even if another draft became active", async () => {
    const activeForWork = vi.fn().mockResolvedValueOnce({ id: D1 }).mockResolvedValue({ id: D2 });
    const resolve = vi.fn(async (draftId: DraftId, documentId: DocumentId) => ({
      item: { itemKey: draftItemKey(draftId, documentId), draftBranchId: null },
      listed: true,
    }));
    const identity = createDraftReviewIdentity({
      drafts: { activeForWork } as never,
      reviewItems: { resolve } as never,
    });
    const resolved = await identity.resolveReviewItem({
      workId: WORK,
      itemKey: draftItemKey(D1, DOC),
    });
    expect(resolved?.draftId).toBe(D1);
    expect(resolve).toHaveBeenCalledWith(D1, DOC);
  });
});

__mergedSuite("draft-review-writer-classes.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/draft-review-writer-classes.test.ts.
  __mergedSuite("writer review classes", () => {
    it.each([0, 1])("keeps independent writer typing separate in block %i", (blockIndex) => {
      const live = createDoc(
        "Alpha base with plenty of unchanged words around the edits.\n\nBeta base with plenty of unchanged words.\n\nGamma base with plenty of unchanged words.",
      );
      const draft = cloneDoc(live);
      const edit = (client: number, block: number, at: number, text: string) => {
        draft.clientID = client;
        return captureUpdate(draft, () =>
          model.applyTextEdit(
            toDocHandle(draft),
            model.getBlocks(toDocHandle(draft))[block],
            { from: at, to: at },
            text,
          ),
        );
      };
      const rows = [
        { id: 10, actorTurnId: "ai", updateData: edit(10, 0, 6, "proposed ") },
        {
          id: 11,
          actorUserId: "writer",
          actorTurnId: null,
          updateData: edit(11, 0, 10, "inside "),
        },
        {
          id: 12,
          actorUserId: "writer",
          actorTurnId: null,
          updateData: edit(
            12,
            blockIndex,
            model.getText(model.getBlocks(toDocHandle(draft))[blockIndex]).length,
            " Independent",
          ),
        },
      ];
      const result = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: draft,
        model: model,
        draftUpdates: rows,
      });
      const classes = [...new Set(result.operations.map((op) => op.closureClassId))];
      expect(classes).toHaveLength(2);
      for (const id of classes) {
        const selected = new Set(
          result.operations
            .filter((op) => op.closureClassId === id)
            .flatMap((op) => op.closureUpdateIds),
        );
        const replay = cloneDoc(live);
        for (const row of rows)
          if (selected.has(row.id as never)) Y.applyUpdate(replay, row.updateData);
        expect(replay.store.pendingStructs).toBeNull();
        expect(replay.store.pendingDs).toBeNull();
        const text = model
          .getBlocks(toDocHandle(replay))
          .map((block) => model.getText(block))
          .join("\n\n");
        expect(text.includes("Independent")).toBe(selected.has(12 as never));
        expect(text.includes("propinside osed")).toBe(selected.has(10 as never));
        replay.destroy();
      }
      live.destroy();
      draft.destroy();
    });
    it("keeps a same-client word typing burst in one writer change", () => {
      const live = createDoc("Alpha base.");
      const draft = cloneDoc(live);
      const rows = [..."word"].map((letter, index) => ({
        id: index + 10,
        actorUserId: "writer",
        actorTurnId: null,
        updateData: captureUpdate(draft, () =>
          model.applyTextEdit(
            toDocHandle(draft),
            model.getBlocks(toDocHandle(draft))[0],
            { from: index, to: index },
            letter,
          ),
        ),
      }));
      const result = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: draft,
        model: model,
        draftUpdates: rows,
      });
      expect(new Set(result.operations.map((op) => op.closureClassId)).size).toBe(1);
      expect(result.operations.every((op) => op.kind === "writer")).toBe(true);
      live.destroy();
      draft.destroy();
    });
  });
});
