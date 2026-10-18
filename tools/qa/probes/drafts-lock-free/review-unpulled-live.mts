/**
 * A Work draft's review while live is ahead of the draft's last pull. Live gains paragraphs and
 * loses one before the debounced live-to-draft pull merges them into the draft; the review must
 * still list only the draft's own change: live's new paragraphs are not the draft's removals,
 * live's deleted one is not the draft's insertion, and nothing is unattributed. The draft's change
 * stays selectable for Apply. Pure review functions over constructed cuts: no database.
 */
import assert from "node:assert/strict";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import {
  deriveReviewCut,
  selectReviewCut,
} from "../../../../apps/server/server/domains/collab/domain/review-cut.ts";
import { yProsemirrorModel } from "../../../../packages/agent-edit/src/model/y-prosemirror.ts";
import { observe, type Probe, Y } from "./harness.mts";

const FRAGMENT = "prosemirror";

function paragraph(text: string): Y.XmlElement {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  return element;
}

export const reviewUnpulledLive: Probe = {
  name: "review-unpulled-live",
  decision: "live-edit-review",
  expected:
    "one hunk, the draft's own insertion, attributed; no hunk shows live's unpulled paragraphs; Apply selects it",
  async run() {
    const model = yProsemirrorModel(buildDocumentSchema());
    const base = new Y.Doc({ gc: false });
    base.clientID = 100;
    base
      .getXmlFragment(FRAGMENT)
      .insert(0, [paragraph("Chapter one"), paragraph("Mira waited"), paragraph("The storm")]);

    // The draft: the base as last pulled, plus one writer keystroke row in the last paragraph.
    const draft = new Y.Doc({ gc: false });
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(base));
    draft.clientID = 200;
    let rowUpdate: Uint8Array | undefined;
    const capture = (update: Uint8Array) => {
      rowUpdate = update;
    };
    draft.on("update", capture);
    ((draft.getXmlFragment(FRAGMENT).get(2) as Y.XmlElement).get(0) as Y.XmlText).insert(
      9,
      " broke",
    );
    draft.off("update", capture);
    if (!rowUpdate) throw new Error("no draft update");
    const history = [
      {
        id: 1,
        draftId: "draft_unpulled",
        generation: 1,
        status: "active",
        source: "writer",
        threadId: null,
        turnId: null,
        wId: null,
        actorUserId: "writer",
        updateData: rowUpdate,
        updateMeta: { documentEdit: { editId: "1", ordinal: 0 } },
        createdAt: new Date(),
      },
    ];

    // Live since that pull: another writer adds three paragraphs and deletes one.
    const live = new Y.Doc({ gc: false });
    Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
    live.clientID = 300;
    const liveFragment = live.getXmlFragment(FRAGMENT);
    liveFragment.insert(1, [paragraph("random"), paragraph("in"), paragraph("live")]);
    liveFragment.delete(4, 1); // "Mira waited"

    const links = { holder: { uri: "project://probe.md" } };
    const cut = {
      documentDraft: {
        draftId: "draft_unpulled",
        documentId: "doc",
        branchId: "branch",
        kind: "work_draft",
        status: "active",
        generation: 1,
        revision: 1,
        state: Y.encodeStateAsUpdate(draft),
      },
      history,
      live: { state: Y.encodeStateAsUpdate(live), revision: "live-ahead" },
      links: { live: links, draft: links },
      item: {
        branchId: "branch",
        itemKey: "item",
        wholeItem: false,
        isNew: false,
        tokens: { locationToken: "same" },
      },
      threadTitles: new Map(),
    } as never;

    const { preview, diagnostics } = deriveReviewCut(cut, model);
    const shown = preview.hunks.map((hunk) =>
      hunk.kind === "text"
        ? { kind: hunk.kind, deleted: hunk.deletedText ?? "", ops: hunk.operationIds }
        : {
            kind: hunk.kind,
            deleted: hunk.deletedBlock?.display ?? "",
            inserted: hunk.insertedBlock?.display ?? "",
            ops: hunk.operationIds,
          },
    );
    observe("hunks", shown);
    observe(
      "unattributed",
      diagnostics.map((diagnostic) => diagnostic.hunkId),
    );
    assert.deepEqual(diagnostics, [], "a hunk no draft row explains");
    assert.equal(preview.hunks.length, 1, "only the draft's own change is reviewed");
    const [hunk] = preview.hunks;
    assert.equal(hunk?.kind, "text");
    assert.equal(hunk.kind === "text" ? (hunk.deletedText ?? "") : "?", "");
    assert.deepEqual(hunk?.operationIds, [preview.operations[0]?.operationId]);

    const selected = selectReviewCut(
      cut,
      model,
      (cut as { documentDraft: never }).documentDraft,
      history as never,
      {
        kind: "apply",
        liveRevisionToken: preview.liveRevisionToken,
        draftRevisionToken: preview.draftRevisionToken,
        operationIds: preview.operations.map((operation) => operation.operationId),
      } as never,
    );
    observe("apply", { journalIds: selected.journalIds });
    assert.deepEqual(selected.journalIds, [1]);
    for (const doc of [base, draft, live]) doc.destroy();
  },
};
