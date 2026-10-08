// Real write-tool journal deltas and selective-review replay contracts.
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { createSemanticProvenanceWriter } from "./provenance.js";

const model = yProsemirrorModel(buildDocumentSchema());
const original =
  "Alpha sword gleamed. The elder waited beside the gate, studying the long road in silence.\n\n" +
  "Beta shield shone. The disciple waited beside the river, studying the distant mountain in silence.";
const text = (doc: Y.Doc) =>
  model
    .getBlocks(toDocHandle(doc))
    .map((block) => model.getText(block))
    .join("\n\n");
function clone(doc: Y.Doc) {
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

describe("per-write journal encoding", () => {
  it.each([
    {
      name: "two overwrite chats, aligned different paragraphs",
      sameChat: false,
      reread: true,
      sentence: false,
      dependent: false,
      classes: 2,
      overwrite: true,
    },
    {
      name: "two chats, different paragraphs",
      sameChat: false,
      reread: true,
      sentence: false,
      dependent: false,
      classes: 2,
    },
    {
      name: "two chats, different sentences",
      sameChat: false,
      reread: true,
      sentence: true,
      dependent: false,
      classes: 2,
    },
    {
      name: "one chat, two turns with a read between",
      sameChat: true,
      reread: true,
      sentence: false,
      dependent: false,
      classes: 2,
    },
    {
      name: "one chat retains its clock chain without a read",
      sameChat: true,
      reread: false,
      sentence: false,
      dependent: false,
      classes: 1,
    },
    {
      name: "B edits text supplied by A",
      sameChat: false,
      reread: true,
      sentence: false,
      dependent: true,
      classes: 1,
    },
  ])("$name", async ({ sameChat, reread, sentence, dependent, classes, overwrite }) => {
    let client = 50000;
    const docs: Y.Doc[] = [];
    const h = createWriteToolHarness(
      { "chapter.md": original },
      {
        semanticProvenance: createSemanticProvenanceWriter(),
        createRuntimeDoc: () => {
          const doc = new Y.Doc({ gc: false });
          doc.clientID = client++;
          docs.push(doc);
          return doc;
        },
      },
    );
    const draft = h.liveDoc("chapter.md");
    const live = clone(draft);
    const edits = [
      { find: "sword", content: "blade" },
      dependent
        ? { find: "blade", content: "bright blade" }
        : sentence
          ? { find: "The elder waited", content: "The master watched" }
          : { find: "shield", content: "buckler" },
    ];
    try {
      for (const [i, edit] of edits.entries()) {
        const threadId = i === 0 || sameChat ? "chat-a" : "chat-b";
        const context = {
          sessionId: threadId,
          threadId,
          turnId: `turn-${i + 1}`,
          responseId: `reply-${i + 1}`,
          ...(overwrite ? { createdDocument: false } : {}),
          interactionContext: {
            mode: "threadPeer" as const,
            afterJournalId: i,
            branchGeneration: 1,
          },
        };
        if (i === 0 || !sameChat || reread)
          expect((await h.core.read({ file: "chapter.md" }, context)).result.status).toBe(
            "success",
          );
        expect(
          (
            await h.core.write(
              overwrite
                ? {
                    command: "create",
                    file: "chapter.md",
                    overwrite: true,
                    content: text(draft).replace(edit.find, edit.content),
                  }
                : { command: "replace", file: "chapter.md", ...edit },
              context,
            )
          ).result.status,
        ).toBe("success");
        expect((await h.core.commitResponse(context.responseId)).status).toBe("committed");
      }
      const journal = await h.journal.read("chapter.md");
      expect(journal.updates).toHaveLength(2);
      const rows = journal.updates.map((row, i) => ({
        id: i + 1,
        actorTurnId: `turn-${i + 1}`,
        updateData: row.update,
      }));
      const preview = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: draft,
        model,
        draftUpdates: rows,
      });
      if (!dependent) expect(preview.operations).toHaveLength(2);
      const classIds = new Set(preview.operations.map((op) => op.closureClassId));
      expect(classIds.size).toBe(classes);
      // Every server-vended class replays alone with exactly its claimed effects.
      for (const classId of classIds) {
        const selected = preview.operations.filter((op) => op.closureClassId === classId);
        const ids = new Set<number>(selected.flatMap((op) => op.closureUpdateIds));
        if (classes === 2) expect([...ids]).toEqual(selected.map((op) => Number(op.operationId)));
        const applied = clone(live);
        try {
          for (const row of rows.filter((row) => ids.has(row.id)))
            Y.applyUpdate(applied, row.updateData);
          let expected = original;
          for (const [i, edit] of edits.entries())
            if (ids.has(i + 1)) expected = expected.replace(edit.find, edit.content);
          expect(text(applied)).toBe(expected);
          expect(applied.store.pendingStructs).toBeNull();
          expect(applied.store.pendingDs).toBeNull();
        } finally {
          applied.destroy();
        }
      }
      expect(text(draft)).toBe(
        original.replace(edits[0].find, edits[0].content).replace(edits[1].find, edits[1].content),
      );
    } finally {
      live.destroy();
      draft.destroy();
      for (const doc of docs) doc.destroy();
    }
  });
});
