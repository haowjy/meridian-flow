/** Checkpoint restore safety-notice producer coverage. */

import {
  createAgentEditCodec,
  type DocumentCoordinator,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Ok } from "../../shared/result.js";
import type { NoticePort } from "../notices/index.js";
import { createCheckpointService } from "./checkpoints.js";

const DOC_ID = "chapter.md";
const schema = buildDocumentSchema();
const codec = createAgentEditCodec(mdxCodec({ schema }));
const model = yProsemirrorModel(schema);

function document(markdown: string): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(doc), null, codec.parse(markdown));
  return doc;
}

describe("checkpoint restore notices", () => {
  it("uses authority-head snapshot replacement instead of merging checkpoint bytes", async () => {
    const liveDoc = document("new generation");
    const checkpointDoc = document("checkpoint generation");
    const replaceAuthorityGeneration = vi.fn(async () => ({ generation: 2n }));
    const restoreFromYDoc = vi.fn(async () => Ok(undefined));
    const service = createCheckpointService({
      coordinator: {
        async withDocument(_docId, operation) {
          return operation(liveDoc);
        },
        async recover() {},
      },
      store: {
        async createCheckpoint() {
          return "checkpoint-1";
        },
        async getCheckpoint() {
          return {
            id: "checkpoint-1",
            documentId: DOC_ID,
            state: Y.encodeStateAsUpdate(checkpointDoc),
            attributionManifest: { version: 1, attributions: [] },
            reason: "before rewrite",
            createdAt: new Date().toISOString(),
          };
        },
        async listCheckpoints() {
          return [];
        },
      },
      latestUpdateSeq: async () => 1,
      markdownDocuments: { restoreFromYDoc },
      replaceAuthorityGeneration,
    });

    await expect(service.restore(DOC_ID, "checkpoint-1")).resolves.toEqual(Ok(undefined));
    expect(replaceAuthorityGeneration).toHaveBeenCalledWith(DOC_ID, "checkpoint-1");
    expect(restoreFromYDoc).not.toHaveBeenCalled();
    expect(model.serializeBlockLines(toDocHandle(liveDoc), codec).join("\n")).toContain(
      "new generation",
    );
  });

  it("records discarded block hashes, bodies, and the pre-restore journal reference", async () => {
    const liveDoc = document("Kept.\n\nDiscarded writer paragraph.");
    const checkpointDoc = document("Kept.");
    const coordinator: DocumentCoordinator = {
      async withDocument(_docId, operation) {
        return operation(liveDoc);
      },
      async recover() {},
    };
    const record = vi.fn<NoticePort["record"]>(async () => {});
    const service = createCheckpointService({
      coordinator,
      store: {
        async createCheckpoint() {
          return "checkpoint-1";
        },
        async getCheckpoint() {
          return {
            id: "checkpoint-1",
            documentId: DOC_ID,
            state: Y.encodeStateAsUpdate(checkpointDoc),
            reason: "before rewrite",
            createdAt: new Date().toISOString(),
          };
        },
        async listCheckpoints() {
          return [];
        },
      },
      async latestUpdateSeq() {
        return 42;
      },
      markdownDocuments: {
        async restoreFromYDoc() {
          return Ok(undefined);
        },
      },
      notices: {
        record,
        async drainForModelContext() {
          return [];
        },
        async drainForWriter() {
          return [];
        },
        subscribeWriterVisible() {
          return () => {};
        },
      },
      model,
      codec,
    });

    await expect(service.restore(DOC_ID, "checkpoint-1")).resolves.toEqual(Ok(undefined));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "checkpoint_sweep",
        scope: { kind: "document", documentId: DOC_ID },
        writerVisible: true,
        data: expect.objectContaining({
          beforeContentRef: 42,
          sweptBlockHashes: expect.any(Array),
          capturedDeletedBodies: expect.arrayContaining([
            expect.objectContaining({ body: "Discarded writer paragraph." }),
          ]),
        }),
      }),
    );
  });
});
