/**
 * Decision D18: a Discard request says whether its member list is complete, and the server
 * answers `gone` only from complete evidence. A 502-member selection is sent the way the client
 * sends one past its cap, an even 500-key sample that omits the last member. The draft then
 * re-forks away the sampled members, keeps the omitted one, and grows its class. The sampled
 * request must answer `stale` (an unsampled member survives), never `gone`; the complete list
 * answers `stale` too; and a complete list whose members all left answers `gone`. Pure review
 * functions over constructed cuts: no database.
 */
import assert from "node:assert/strict";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import {
  deriveReviewCut,
  selectReviewCut,
} from "../../../../apps/server/server/domains/collab/domain/review-cut.ts";
import { yProsemirrorModel } from "../../../../packages/agent-edit/src/model/y-prosemirror.ts";
import { observe, type Probe, Y } from "./harness.mts";

type Row = Record<string, unknown> & { id: number; updateData: Uint8Array };

export const d18SampledDiscard: Probe = {
  name: "d18-sampled-discard",
  decision: "D18",
  expected:
    "sampled incomplete negative: `stale`; complete with a survivor: `stale`; complete with every member gone: `gone`",
  async run() {
    const model = yProsemirrorModel(buildDocumentSchema());
    const base = new Y.Doc({ gc: false });
    base.clientID = 100;
    for (const text of ["Base A", "Base B"]) {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(text)]);
      const fragment = base.getXmlFragment("prosemirror");
      fragment.insert(fragment.length, [paragraph]);
    }
    const draft = new Y.Doc({ gc: false });
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(base));
    const history: Row[] = [];
    const keyRow = (id: number, doc: Y.Doc, block: number, char: string): Row => {
      let update: Uint8Array | undefined;
      const capture = (next: Uint8Array) => {
        update = next;
      };
      doc.on("update", capture);
      const text = (doc.getXmlFragment("prosemirror").get(block) as Y.XmlElement).get(
        0,
      ) as Y.XmlText;
      text.insert(text.length, char);
      doc.off("update", capture);
      if (!update) throw new Error("no update");
      const row: Row = {
        id,
        draftId: "draft_sampling",
        generation: 1,
        status: "active",
        source: "writer",
        threadId: null,
        turnId: null,
        wId: null,
        actorUserId: "writer",
        updateData: update,
        updateMeta: { documentEdit: { editId: String(id), ordinal: 0 } },
        createdAt: new Date(),
      };
      history.push(row);
      return row;
    };
    draft.clientID = 200;
    for (let id = 1; id <= 501; id++) keyRow(id, draft, 0, "a");
    draft.clientID = 300;
    keyRow(502, draft, 1, "b");
    const links = { holder: { uri: "project://probe.md" } };
    const cut = (doc: Y.Doc, rows: readonly Row[], generation: number) =>
      ({
        documentDraft: {
          draftId: "draft_sampling",
          documentId: "doc",
          branchId: "branch",
          kind: "work_draft",
          status: "active",
          generation,
          revision: generation,
          state: Y.encodeStateAsUpdate(doc),
        },
        history: rows,
        live: { state: Y.encodeStateAsUpdate(base), revision: "unchanged-live" },
        links: { live: links, draft: links },
        item: {
          branchId: "branch",
          itemKey: "item",
          wholeItem: false,
          isNew: false,
          tokens: { locationToken: "same" },
        },
        threadTitles: new Map(),
      }) as never;
    const preview = deriveReviewCut(cut(draft, history, 1), model).preview;
    const keys = preview.operations.map((operation) => operation.partKey as string);
    const classes = [...new Set(preview.operations.map((operation) => operation.closureClassId))];
    assert.equal(keys.length, 502);
    assert.equal(classes.length, 2);
    const sample = Array.from({ length: 500 }, (_, i) => keys[Math.floor((i * keys.length) / 500)]);
    const command = {
      kind: "discard",
      liveRevisionToken: "unchanged-live",
      closureClassIds: classes,
      admissionTokens: preview.operations.map((operation) => operation.admissionToken),
    };
    const answer = (
      now: ReturnType<typeof cut>,
      rows: readonly Row[],
      members: string[],
      complete: boolean,
    ) => {
      try {
        selectReviewCut(
          now,
          model,
          (now as { documentDraft: never }).documentDraft,
          rows as never,
          {
            ...command,
            memberPartKeys: members,
            memberPartKeysComplete: complete,
          } as never,
        );
        return "selected";
      } catch (cause) {
        return (cause as { status?: string }).status ?? (cause as Error).name;
      }
    };

    // The sampled members were re-forked away; the omitted one survives and its class grew.
    const survivor = new Y.Doc({ gc: false });
    Y.applyUpdate(survivor, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(survivor, history[501]?.updateData ?? new Uint8Array());
    survivor.clientID = 300;
    keyRow(503, survivor, 1, "c");
    const remaining = history
      .slice(501)
      .map((row) => ({ ...row, id: row.id + 1000, generation: 2 }));
    const grown = cut(survivor, remaining, 2);
    const sampled = answer(grown, remaining, sample, false);
    const full = answer(grown, remaining, keys, true);

    // Every clicked member left: a complete list proves absence.
    const emptied = new Y.Doc({ gc: false });
    Y.applyUpdate(emptied, Y.encodeStateAsUpdate(base));
    const gone = answer(cut(emptied, [], 2), [], keys, true);

    observe("selection", {
      members: keys.length,
      sampleSize: sample.length,
      sampleOmitsSurvivor: !sample.includes("502:0"),
    });
    observe("answers", { sampledIncomplete: sampled, complete: full, completeAllGone: gone });
    assert.equal(sample.includes("502:0"), false);
    assert.equal(sampled, "stale");
    assert.equal(full, "stale");
    assert.equal(gone, "gone");
    for (const doc of [base, draft, survivor, emptied]) doc.destroy();
  },
};
