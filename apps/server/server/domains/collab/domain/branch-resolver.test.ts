/** BranchResolver conformance tests for thread-peer branch snapshots. */

import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createInMemoryBranchStore } from "./__fixtures__/in-memory-branch-resolver.js";
import {
  BranchCorruptError,
  BranchNotFoundError,
  isBranchCorruptError,
  isBranchNotFoundError,
} from "./branch-resolver.js";
import { StaleDocumentSchemaError } from "./stale-schema.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000301" as DocumentId;
const THREAD_ID = "00000000-0000-4000-8000-000000000302" as ThreadId;
const WORK_ID = "00000000-0000-4000-8000-000000000303" as WorkId;

function docWithText(value: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return doc;
}

function readText(doc: Y.Doc): string {
  return doc.getText("content").toString();
}

describe("BranchResolver", () => {
  it("resolve with corrupt snapshot throws BranchCorruptError, not an empty doc", async () => {
    const store = createInMemoryBranchStore();
    const upstream = store.seedWorkDraft({
      documentId: DOCUMENT_ID,
      workId: WORK_ID,
      doc: docWithText("upstream"),
    });
    store.insert({
      id: "thread-corrupt",
      documentId: DOCUMENT_ID,
      kind: "thread_peer",
      upstreamBranchId: upstream.id,
      workId: WORK_ID,
      threadId: THREAD_ID,
      pushPolicy: "manual",
      generation: 1,
      state: new Uint8Array([1, 2, 3]),
      stateVector: new Uint8Array([0]),
      status: "active",
      schemaVersion: COLLAB_SCHEMA_VERSION,
    });

    await expect(store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID)).rejects.toThrow(
      BranchCorruptError,
    );
    await expect(store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID)).rejects.toSatisfy(
      isBranchCorruptError,
    );
  });

  it("resolve with missing branch row throws BranchNotFoundError, not an empty doc", async () => {
    const store = createInMemoryBranchStore();
    store.seedWorkDraft({ documentId: DOCUMENT_ID, workId: WORK_ID, doc: docWithText("upstream") });

    await expect(store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID)).rejects.toThrow(
      BranchNotFoundError,
    );
    await expect(store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID)).rejects.toSatisfy(
      isBranchNotFoundError,
    );
  });

  it("creates an absent thread peer from a non-empty upstream before retrying resolve", async () => {
    const store = createInMemoryBranchStore();
    const upstream = store.seedWorkDraft({
      documentId: DOCUMENT_ID,
      workId: WORK_ID,
      doc: docWithText("existing upstream prose"),
    });

    await expect(store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID)).rejects.toThrow(
      BranchNotFoundError,
    );

    store.createThreadPeerFromUpstream({
      documentId: DOCUMENT_ID,
      threadId: THREAD_ID,
      upstreamBranchId: upstream.id,
    });

    const resolved = await store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID);
    expect(readText(resolved.doc)).toBe("existing upstream prose");
  });

  it("surfaces generation and increments it on reset from upstream", async () => {
    const store = createInMemoryBranchStore();
    const upstream = store.seedWorkDraft({
      documentId: DOCUMENT_ID,
      workId: WORK_ID,
      doc: docWithText("generation one"),
    });
    const peer = store.createThreadPeerFromUpstream({
      documentId: DOCUMENT_ID,
      threadId: THREAD_ID,
      upstreamBranchId: upstream.id,
    });

    const first = await store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID);
    expect(first.generation).toBe(1);

    const updatedUpstream = docWithText("generation two");
    store.rows.set(upstream.id, {
      ...upstream,
      state: Y.encodeStateAsUpdate(updatedUpstream),
      stateVector: Y.encodeStateVector(updatedUpstream),
    });
    store.resetFromUpstream({ branchId: peer.id, expectedGeneration: first.generation });

    const second = await store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID);
    expect(second.generation).toBe(2);
    expect(readText(second.doc)).toBe("generation two");
  });

  it("fails loud on stale schema instead of silently reseeding", async () => {
    const store = createInMemoryBranchStore();
    const upstream = store.seedWorkDraft({
      documentId: DOCUMENT_ID,
      workId: WORK_ID,
      doc: docWithText("schema guarded"),
    });
    const peer = store.createThreadPeerFromUpstream({
      documentId: DOCUMENT_ID,
      threadId: THREAD_ID,
      upstreamBranchId: upstream.id,
    });
    store.rows.set(peer.id, { ...peer, schemaVersion: COLLAB_SCHEMA_VERSION - 1 });

    await expect(store.resolveThreadBranch(DOCUMENT_ID, THREAD_ID)).rejects.toThrow(
      StaleDocumentSchemaError,
    );
  });
});
