// A host-prepared write is admitted under the document's lock only where its base is.
// The replaced-generation refusal and the host's re-prepare are witnessed end to end by the
// A2-R2 rows in apps/server/server/domains/collab/link-binding.db.test.ts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { toDocHandle } from "../handles.js";
import type { JournalAuthority } from "../ports/update-journal.js";
import { blockTexts } from "./test-support/assertions.js";
import { codec, context, harness, model } from "./test-support/write-tool-harness.js";

const GENERATION_1: JournalAuthority = { authorityId: "authority-a", generation: 1n };

/** A write prepared now: against the live document (`fresh`: against an empty one). */
function preparedSetup(live: JournalAuthority, fresh: boolean) {
  const ctx = harness({ "chapter.md": "Alpha." });
  Object.assign(ctx.coordinator, { documentAuthority: () => live });
  const draft = new Y.Doc({ gc: false });
  if (!fresh) Y.applyUpdate(draft, Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md")));
  const stateVector = Y.encodeStateVector(draft);
  model.insertBlocks(toDocHandle(draft), null, codec.parse("Prepended."));
  const update = Y.encodeStateAsUpdate(draft, stateVector);
  draft.destroy();
  const write = () =>
    ctx.core.applyPrepared(
      {
        documentId: "chapter.md",
        base: fresh ? null : { authority: live, stateVector },
        update,
        certified: null,
      },
      { ...context, actor: { kind: "agent", turnId: "turn-a", threadId: context.threadId } },
    );
  return { ctx, write };
}

describe("prepared write admission", () => {
  it("admits a prepared write only where its base is, fencing the append", async () => {
    const rows = [
      {
        row: "admitted into the generation its base was read in",
        fresh: false,
        status: "success",
        blocks: ["Prepended.", "Alpha."],
        fence: GENERATION_1,
      },
      {
        row: "a fresh write never lands beside content it never saw",
        fresh: true,
        status: "invalid_write",
        blocks: ["Alpha."],
        fence: undefined,
      },
    ];
    for (const { row, fresh, status, blocks, fence } of rows) {
      const { ctx, write } = preparedSetup(GENERATION_1, fresh);
      const outcome = await write();
      expect.soft(outcome.status, row).toBe(status);
      expect.soft(blockTexts(ctx.liveDoc("chapter.md")), row).toEqual(blocks);
      if (fence) {
        expect.soft(ctx.journal.recordedBatchEntries().at(-1)?.[0]?.authority, row).toEqual(fence);
      }
    }
  });
});
