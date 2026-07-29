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

describe("schema-aware serialization purity", () => {
  it("returns the repaired projection without mutating its source when the anomaly sink throws", async () => {
    const subject = setup("md");
    vi.spyOn(subject.eventSink, "emit").mockImplementation(() => {
      throw new Error("sink-failed");
    });
    const fallbackDiagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
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
      expect(fallbackDiagnostic).toHaveBeenCalledOnce();
    } finally {
      fallbackDiagnostic.mockRestore();
      input.destroy();
    }
  });

  it("repairs only a clone and reports the removed structure without prose", async () => {
    const subject = setup("md");
    const input = createCollabYDoc({ gc: false });
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("kept prose")]);
    const unknown = new Y.XmlElement("sidebar");
    unknown.insert(0, [new Y.XmlText("future prose")]);
    fragmentOf(input).insert(0, [paragraph, unknown]);
    const beforeState = Y.encodeStateAsUpdate(input);
    const beforeXml = fragmentOf(input).toString();

    await expect(subject.engine.serializeDocument(DOCUMENT_ID, input)).resolves.toBe(
      "kept prose\n",
    );

    expect(Y.encodeStateAsUpdate(input)).toEqual(beforeState);
    expect(fragmentOf(input).toString()).toBe(beforeXml);
    expect(subject.eventSink.events).toHaveLength(1);
    expect(subject.eventSink.events[0]).toMatchObject({
      level: "warn",
      source: "collab.schema",
      name: "serialize.anomaly_observed",
      correlation: { documentId: DOCUMENT_ID },
      payload: {
        schemaVersion: COLLAB_SCHEMA_VERSION,
        deletedNodeTypes: ["sidebar"],
        deletedClockCount: 14,
      },
    });
    expect(subject.eventSink.events[0]?.payload).toEqual({
      schemaVersion: COLLAB_SCHEMA_VERSION,
      deletedNodeTypes: ["sidebar"],
      deletedClockCount: 14,
    });
    input.destroy();
  });

  it("emits no anomaly when serialization does not repair the clone", async () => {
    const subject = setup("md");
    const input = createCollabYDoc({ gc: false });
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("kept prose")]);
    fragmentOf(input).insert(0, [paragraph]);

    await expect(subject.engine.serializeDocument(DOCUMENT_ID, input)).resolves.toBe(
      "kept prose\n",
    );

    expect(subject.eventSink.events).toEqual([]);
    input.destroy();
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
