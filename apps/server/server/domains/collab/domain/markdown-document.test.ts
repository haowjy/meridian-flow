/** Schema-aware read and restore contracts for the collab document engine. */
import { fragmentOf, yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
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

function setup(filetype = "typescript") {
  const schema = buildDocumentSchema();
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const eventSink = createInMemoryEventSink();
  const engine = createMarkdownDocumentEngine({
    schema,
    codec: mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
    model: yProsemirrorModel(schema),
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
  it.each([
    [
      "a code checkpoint without turning fences into literal code",
      "typescript",
      "const original = true;",
    ],
    [
      "a document checkpoint's nodes as projected",
      "md",
      '# Title\n\nA *quiet* [link](https://example.com "t").\n',
    ],
  ])("restores %s", async (_name, filetype, original) => {
    const subject = setup(filetype);
    await seedCode(subject, original);
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
      value: original,
    });
  });
});

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
