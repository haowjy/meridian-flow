/** Schema-aware read and restore contracts for the collab document engine. */
import { yProsemirrorModel } from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
} from "../adapters/in-memory/agent-edit.js";
import { createCheckpointService } from "../checkpoints.js";
import { createMarkdownDocumentEngine } from "./markdown-document.js";

const DOCUMENT_ID = "code-document" as DocumentId;
const SYSTEM_ORIGIN = { type: "system" as const };

function setup(filetype = "typescript") {
  const schema = buildDocumentSchema();
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const engine = createMarkdownDocumentEngine({
    schema,
    codec: mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
    model: yProsemirrorModel(schema),
    journal,
    coordinator,
    lifecycle: createInMemoryDocumentLifecycle(coordinator),
    metaForOrigin: () => ({ origin: "system", seq: 0 }),
    resolveFiletype: async () => filetype,
  });
  return { coordinator, engine, journal };
}

async function seedCode(setupResult: ReturnType<typeof setup>, source = "const answer = 42;") {
  const written = await setupResult.engine.setMarkdown({
    documentId: DOCUMENT_ID,
    markdown: source,
    origin: SYSTEM_ORIGIN,
  });
  expect(written.ok).toBe(true);
}

describe("code document serialization", () => {
  it("returns corrupt_state when tracked metadata names a registered non-tracked filetype", async () => {
    const subject = setup("png");

    await expect(
      subject.engine.setMarkdown({
        documentId: DOCUMENT_ID,
        markdown: "not an image",
        origin: SYSTEM_ORIGIN,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "corrupt_state",
        documentId: DOCUMENT_ID,
        message: "Tracked document has registered binary filetype: png",
      },
    });
  });

  it("reads a code-schema document without markdown fences", async () => {
    const subject = setup();
    await seedCode(subject);

    await expect(subject.engine.readAsMarkdown(DOCUMENT_ID)).resolves.toEqual({
      ok: true,
      value: "const answer = 42;",
    });
  });

  it.each([
    "effective branch/staged reads",
    "review previews",
  ])("serializes Y.Doc projections without fences for %s", async () => {
    const subject = setup();
    await seedCode(subject);
    const projection = createCollabYDoc({ gc: false });
    await subject.coordinator.withDocument(DOCUMENT_ID, async (live) => {
      Y.applyUpdate(projection, Y.encodeStateAsUpdate(live));
    });

    await expect(subject.engine.serializeDocument(DOCUMENT_ID, projection)).resolves.toBe(
      "const answer = 42;",
    );
    projection.destroy();
  });

  it("restores a code checkpoint without turning fences into literal code", async () => {
    const subject = setup();
    await seedCode(subject, "const original = true;");
    const checkpoints = createCheckpointService({
      coordinator: subject.coordinator,
      store: subject.journal,
      latestUpdateSeq: (documentId) => subject.journal.latestUpdateSeq(documentId),
      markdownDocuments: subject.engine,
    });
    const checkpoint = await checkpoints.checkpoint(DOCUMENT_ID, "before edit");
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw new Error("checkpoint failed");

    await subject.engine.setMarkdown({
      documentId: DOCUMENT_ID,
      markdown: "const changed = true;",
      origin: SYSTEM_ORIGIN,
    });
    await expect(checkpoints.restore(DOCUMENT_ID, checkpoint.value)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(subject.engine.readAsMarkdown(DOCUMENT_ID)).resolves.toEqual({
      ok: true,
      value: "const original = true;",
    });
  });
});
