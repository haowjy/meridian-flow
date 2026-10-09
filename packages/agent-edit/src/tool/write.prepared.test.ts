// A host-prepared create is admitted only into the authority generation its base was read in.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { toDocHandle } from "../handles.js";
import type { JournalAuthority } from "../ports/update-journal.js";
import { blockTexts, expectOutcome } from "./test-support/assertions.js";
import { codec, context, harness, model } from "./test-support/write-tool-harness.js";

const GENERATION_1: JournalAuthority = { authorityId: "authority-a", generation: 1n };
const GENERATION_2: JournalAuthority = { authorityId: "authority-a", generation: 2n };

/** The live document's generation is `live`; a write prepared against it now. */
function preparedSetup(live: JournalAuthority) {
  const ctx = harness({ "chapter.md": "Alpha." });
  Object.assign(ctx.coordinator, { documentAuthority: () => live });
  const draft = new Y.Doc({ gc: false });
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md")));
  const base = Y.encodeStateVector(draft);
  const parsed = codec.parse("Prepended.");
  model.insertBlocks(toDocHandle(draft), null, parsed);
  const update = Y.encodeStateAsUpdate(draft, base);
  const blocks = model.projectBlocks(toDocHandle(draft));
  draft.destroy();
  const write = (authority: JournalAuthority, extra: { responseId?: string } = {}) =>
    ctx.core.write(
      { command: "create", file: "chapter.md", content: "Prepended.\n\nAlpha.", overwrite: true },
      { ...context, ...extra, prepared: { blocks, update, authority } },
    );
  return { ctx, write };
}

describe("prepared create certification", () => {
  it("admits a prepared write into the generation its base was read in, fencing the append", async () => {
    const { ctx, write } = preparedSetup(GENERATION_1);

    expectOutcome(await write(GENERATION_1), "success");

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Prepended.", "Alpha."]);
    expect(ctx.journal.recordedBatchEntries().at(-1)?.[0]?.authority).toEqual(GENERATION_1);
  });

  it("refuses, as a stale base for the host to prepare again, a write whose generation was replaced", async () => {
    const { ctx, write } = preparedSetup(GENERATION_2);

    const outcome = await write(GENERATION_1);

    expectOutcome(outcome, "invalid_write", true);
    expect(outcome.error).toEqual({
      type: "prepared_base",
      code: "authority_replaced",
      documentId: "chapter.md",
    });
    expect(ctx.journal.recordedBatches()).toEqual([]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
  });

  it("never stages a prepared write, where its certificate would go unchecked", async () => {
    const { ctx, write } = preparedSetup(GENERATION_1);

    expectOutcome(await write(GENERATION_1, { responseId: "response-a" }), "invalid_write", true);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
  });
});
