/** Checkpoint restore behavior coverage. */

import { createAgentEditCodec, toDocHandle, yProsemirrorModel } from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Ok } from "../../shared/result.js";
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
    const mutate = vi.fn(async () => ({ generation: 2n }));
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
      mutationPolicy: () => ({ mutate }) as never,
    });

    await expect(service.restore(DOC_ID, "checkpoint-1")).resolves.toEqual(Ok(undefined));
    expect(mutate).toHaveBeenCalledWith({
      kind: "authorityHeadSnapshotReplacement",
      checkpointId: "checkpoint-1",
      replaceGeneration: true,
    });
    expect(restoreFromYDoc).not.toHaveBeenCalled();
    expect(model.serializeBlockLines(toDocHandle(liveDoc), codec).join("\n")).toContain(
      "new generation",
    );
  });

  it("restores through the document mutation boundary without requiring a notice recorder", async () => {
    const liveDoc = document("Current generation.");
    const checkpointDoc = document("Kept.");
    const restoreFromYDoc = vi.fn(async (_documentId: string, restored: Y.Doc) => {
      expect(model.serializeBlockLines(toDocHandle(restored), codec).join("\n")).toContain("Kept.");
      return Ok(undefined);
    });
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
        restoreFromYDoc,
      },
    });

    await expect(service.restore(DOC_ID, "checkpoint-1")).resolves.toEqual(Ok(undefined));
    expect(restoreFromYDoc).toHaveBeenCalledOnce();
  });
});
