import { YJS_WS_CLOSE } from "@meridian/contracts/protocol";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";

import {
  classifyDocumentTransportClose,
  createDurableSyncBarrier,
  parseSafetyNotice,
  schemaVersionedYjsWsPath,
} from "./hocuspocus-document-transport";

describe("Hocuspocus document close classification", () => {
  it("maps schema refusals to terminal reset states", () => {
    expect(
      classifyDocumentTransportClose("document-1", YJS_WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED),
    ).toEqual({
      kind: "reset",
      reason: "client-schema-superseded",
      code: 4406,
    });
    expect(
      classifyDocumentTransportClose("document-1", YJS_WS_CLOSE.DOCUMENT_SCHEMA_STALE),
    ).toEqual({
      kind: "reset",
      reason: "document-schema-stale",
      code: 4407,
    });
  });

  it("keeps unrelated closes reconnectable and existing branch resets terminal", () => {
    expect(
      classifyDocumentTransportClose("document-1", { code: 1006, reason: "network-drop" }),
    ).toBeNull();
    expect(
      classifyDocumentTransportClose("branch:branch-1:gen:1", {
        code: 4205,
        reason: "branch-stale-doc",
      }),
    ).toEqual({ kind: "reset", reason: "branch-stale-doc", code: 4205 });
  });

  it("declares the bundle schema version on each document socket URL", () => {
    expect(schemaVersionedYjsWsPath()).toBe(`/ws/yjs?schema=${COLLAB_SCHEMA_VERSION}`);
  });
});

describe("Hocuspocus durable sync barrier", () => {
  it("does not settle on initial SyncStep2 while updates remain unacknowledged", async () => {
    const barrier = createDurableSyncBarrier();
    let settled = false;
    void barrier.promise.then(() => {
      settled = true;
    });

    barrier.noteUnsyncedChanges(0);
    barrier.markInitialSyncComplete(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    barrier.noteUnsyncedChanges(0);
    await barrier.promise;
    expect(settled).toBe(true);
  });
});

describe("Hocuspocus document safety notices", () => {
  it("accepts the defined safety_notice stateless payload", () => {
    expect(
      parseSafetyNotice(
        JSON.stringify({
          type: "safety_notice",
          documentId: "document-1",
          kind: "checkpoint_sweep",
          message: "Content was modified — View change",
          data: { beforeContentRef: 42 },
        }),
      ),
    ).toEqual({
      type: "safety_notice",
      documentId: "document-1",
      kind: "checkpoint_sweep",
      message: "Content was modified — View change",
      data: { beforeContentRef: 42 },
    });
  });

  it("ignores malformed stateless payloads", () => {
    expect(parseSafetyNotice("not json")).toBeNull();
    expect(parseSafetyNotice(JSON.stringify({ type: "other" }))).toBeNull();
  });
});
