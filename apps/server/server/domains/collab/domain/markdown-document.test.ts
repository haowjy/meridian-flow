/** Schema-aware read and restore contracts for the collab document engine. */
import { fragmentOf, toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createMarkdownSerializationAnomalyObserver } from "../adapters/agent-edit-observability.js";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
} from "../adapters/in-memory/agent-edit.js";
import { createCheckpointService } from "../checkpoints.js";
import { createMarkdownDocumentEngine } from "./markdown-document.js";

const DOCUMENT_ID = "code-document" as DocumentId;
const SYSTEM_ORIGIN = { type: "system" as const };

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);

function setup(filetype = "typescript") {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const eventSink = createInMemoryEventSink();
  const engine = createMarkdownDocumentEngine({
    links: UNSCOPED_DOCUMENT_LINKS,
    schema,
    codec: mdxCodec({ schema }),
    model,
    journal,
    coordinator,
    lifecycle: createInMemoryDocumentLifecycle(coordinator),
    initialDocumentSeeds: {
      async seedInitialDocument(documentId, state) {
        const snapshot = await journal.read(documentId);
        if (snapshot.checkpoint || snapshot.updates.length > 0) return false;
        await journal.checkpoint(documentId, state, 0);
        return true;
      },
    },
    metaForOrigin: () => ({ origin: "system", seq: 0 }),
    identityPreservingWrite: async () => {
      throw new Error("Identity-preserving writes are not part of this test");
    },
    resolveFiletype: async () => filetype,
    observeSerializationAnomaly: createMarkdownSerializationAnomalyObserver(eventSink),
  });
  return { coordinator, engine, eventSink, journal };
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
    const projection = createCollabYDoc({ gc: false });

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
    await expect(subject.engine.serializeDocument(DOCUMENT_ID, projection)).rejects.toMatchObject({
      code: "corrupt_state",
    });
    projection.destroy();
  });
});

describe("checkpoint restore", () => {
  type Subject = ReturnType<typeof setup>;

  it.each<
    [string, string, (subject: Subject) => Promise<void>, (subject: Subject) => Promise<void>]
  >([
    [
      "a code checkpoint without turning fences into literal code",
      "typescript",
      (subject) => seedCode(subject, "const original = true;"),
      async (subject) => {
        await expect(subject.engine.readAsMarkdown(DOCUMENT_ID)).resolves.toEqual({
          ok: true,
          value: "const original = true;",
        });
      },
    ],
    [
      "a document checkpoint's nodes, including attributes Markdown can't spell",
      "md",
      async (subject) => {
        const live = subject.coordinator.ensureEmpty(DOCUMENT_ID);
        model.insertBlocks(toDocHandle(live), null, { blocks: [uploadingImageParagraph()] });
      },
      async (subject) => {
        const [paragraph] = model.projectBlocks(
          toDocHandle(subject.coordinator.ensureEmpty(DOCUMENT_ID)),
        );
        expect(paragraph?.firstChild?.attrs).toMatchObject({
          src: "pending.png",
          uploadToken: "upload-1",
        });
      },
    ],
  ])("restores %s", async (_name, filetype, seed, expectRestored) => {
    const subject = setup(filetype);
    await seed(subject);
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
    await expectRestored(subject);
  });

  // Risk: a restore that reports failure must not have journaled or installed its content.
  it("leaves the journal and live document untouched when the snapshot can't serialize", async () => {
    const subject = setup("md");
    await seedCode(subject, "Before.");
    const live = subject.coordinator.ensureEmpty(DOCUMENT_ID);
    const liveBefore = Y.encodeStateAsUpdate(live);
    const journalBefore = (await subject.journal.read(DOCUMENT_ID)).updates.length;
    const snapshot = createCollabYDoc({ gc: false });
    model.insertBlocks(toDocHandle(snapshot), null, { blocks: [invalidWidthTable()] });

    await expect(
      subject.engine.restoreFromYDoc(DOCUMENT_ID, snapshot, SYSTEM_ORIGIN),
    ).rejects.toThrow(/colwidth/);
    expect((await subject.journal.read(DOCUMENT_ID)).updates).toHaveLength(journalBefore);
    expect(Y.encodeStateAsUpdate(live)).toEqual(liveBefore);
  });
});

function uploadingImageParagraph() {
  const image = schema.nodes.image.create({ src: "pending.png", uploadToken: "upload-1" });
  return schema.nodes.paragraph.create(null, [image]);
}

function invalidWidthTable() {
  const cell = schema.nodes.table_cell.create({ colwidth: "wrong" }, [
    schema.nodes.paragraph.create(null, [schema.text("cell")]),
  ]);
  return schema.nodes.table.create(null, [schema.nodes.table_row.create(null, [cell])]);
}

describe("schema-aware serialization purity", () => {
  it("returns the repaired projection without mutating its source when the anomaly sink throws", async () => {
    const subject = setup("md");
    vi.spyOn(subject.eventSink, "emit").mockImplementation(() => {
      throw new Error("sink-failed");
    });
    const input = createCollabYDoc({ gc: false });
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("kept prose")]);
    const unknown = new Y.XmlElement("sidebar");
    unknown.insert(0, [new Y.XmlText("future prose")]);
    fragmentOf(input).insert(0, [paragraph, unknown]);
    const beforeState = Y.encodeStateAsUpdate(input);
    const beforeXml = fragmentOf(input).toString();

    try {
      await expect(subject.engine.serializeDocument(DOCUMENT_ID, input)).resolves.toBe(
        "kept prose\n",
      );

      expect(Y.encodeStateAsUpdate(input)).toEqual(beforeState);
      expect(fragmentOf(input).toString()).toBe(beforeXml);
    } finally {
      input.destroy();
    }
  });

  it("preserves source client identity for identity-sensitive projection repairs", async () => {
    const subject = setup("md");
    const input = createCollabYDoc({ gc: false });
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("a"), new Y.XmlText("b")]);
    fragmentOf(input).insert(0, [paragraph]);
    const beforeState = Y.encodeStateAsUpdate(input);

    await expect(subject.engine.serializeDocument(DOCUMENT_ID, input)).resolves.toBe("ab\n");

    expect(Y.encodeStateAsUpdate(input)).toEqual(beforeState);
    expect(subject.eventSink.events).toHaveLength(1);
    expect(subject.eventSink.events[0]?.payload).toEqual({
      schemaVersion: COLLAB_SCHEMA_VERSION,
      deletedNodeTypes: [],
      deletedClockCount: 2,
    });
    input.destroy();
  });
});
