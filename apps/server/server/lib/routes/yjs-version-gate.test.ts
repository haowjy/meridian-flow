/** Connect-time schema compatibility behavior for live Yjs rooms.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Yjs version subprotocol and unstamped admission
 */
import { COLLAB_SCHEMA_VERSION, type CollabSchemaVersion } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import { messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { DocumentSchemaMajorMismatchError } from "../../domains/collab/index.js";
import {
  createAllowAllFileAccess,
  createLocalFileAccessChanges,
} from "../../domains/file-policy/index.js";
import { createInMemoryEventSink } from "../../domains/observability/index.js";
import { createRoomAccessIndex as createYjsRoomAccessIndex } from "../room-access.js";
import { createHocuspocus } from "../yjs-ws-handler.js";

const liveDocumentName = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";
const version = (major: number, minor: number, patch = 0): CollabSchemaVersion => ({
  major,
  minor,
  patch,
});
const SENTINEL_SCHEMA_VERSION = version(0, 0, 0);
/** A head stamped by another collab schema major than this server's. */
const OTHER_MAJOR_HEAD = version(COLLAB_SCHEMA_VERSION.major + 1, 0);

function versionGateServices(input: { liveHead?: CollabSchemaVersion | null } = {}) {
  const documentSync = {
    roomRemoval: vi.fn(async () => null),
    ensureDocumentAuthority: vi.fn(async () => {}),
    bindHocuspocus: vi.fn(),
    headSchemaVersion: vi.fn(async () => (input.liveHead === undefined ? null : input.liveHead)),
    validateHocuspocusDocument: vi.fn(async () => {}),
    admitLiveWriterUpdate: vi.fn(async () => ({
      admitted: true as const,
    })),
  };
  return {
    liveDocuments: {
      findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
    },
    fileAccess: createAllowAllFileAccess(),
    fileAccessChanges: createLocalFileAccessChanges(),
    documentSync,
    eventSink: createInMemoryEventSink(),
    treeLists: { onCommitted: () => () => {}, onJournalAdvanced: () => () => {} },
  };
}

function connectContext(clientSchemaVersion: CollabSchemaVersion) {
  return {
    userId,
    clientSchemaVersion,
    closeTransport: vi.fn(),
  };
}

function staleSchemaError() {
  return new DocumentSchemaMajorMismatchError(
    liveDocumentName,
    OTHER_MAJOR_HEAD,
    COLLAB_SCHEMA_VERSION,
  );
}

function connectionConfig() {
  return { readOnly: false, isAuthenticated: false };
}

describe("Yjs connect-time schema version gate", () => {
  it("refuses only live-room clients strictly older than a stored head", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
    const staleClientContext = connectContext(SENTINEL_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onConnect?.({
        connectionConfig: connectionConfig(),
        documentName: liveDocumentName,
        context: staleClientContext,
      } as never),
    ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
    expect(staleClientContext.closeTransport).toHaveBeenCalledWith({
      code: 4406,
      reason: "client-schema-superseded",
    });
    await expect(
      hocuspocus.configuration.onConnect?.({
        connectionConfig: connectionConfig(),
        documentName: liveDocumentName,
        context: connectContext(COLLAB_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
    expect(services.documentSync.headSchemaVersion).toHaveBeenCalledTimes(2);
    expect(services.documentSync.headSchemaVersion).toHaveBeenCalledWith(liveDocumentName);
  });

  it("preserves the typed refusal when event delivery fails", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    vi.spyOn(services.eventSink, "emit").mockImplementation(() => {
      throw new Error("sink-failed");
    });
    const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
    const context = connectContext(SENTINEL_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onConnect?.({
        connectionConfig: connectionConfig(),
        documentName: liveDocumentName,
        context,
      } as never),
    ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
    expect(context.closeTransport).toHaveBeenCalledOnce();
    expect(context.closeTransport).toHaveBeenCalledWith({
      code: 4406,
      reason: "client-schema-superseded",
    });
    expect(services.eventSink.emit).toHaveBeenCalledOnce();
  });

  it("passes a live room with no stamped head, including an absent-version client", async () => {
    const services = versionGateServices({ liveHead: null });
    const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());

    await expect(
      hocuspocus.configuration.onConnect?.({
        connectionConfig: connectionConfig(),
        documentName: liveDocumentName,
        context: connectContext(SENTINEL_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
    expect(services.eventSink.events).toEqual([]);
  });

  it("rejects sync when the admitted target does not match the message room", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
    const context = connectContext(COLLAB_SCHEMA_VERSION);

    await hocuspocus.configuration.onConnect?.({
      connectionConfig: connectionConfig(),
      documentName: liveDocumentName,
      context,
    } as never);
    await expect(
      hocuspocus.configuration.beforeSync?.({
        documentName: "00000000-0000-4000-8000-000000000999",
        document: new Y.Doc({ gc: false }),
        type: messageYjsUpdate,
        payload: new Uint8Array([1, 2, 3]),
        context,
      } as never),
    ).rejects.toMatchObject({ reason: "permission-denied" });
    expect(services.documentSync.admitLiveWriterUpdate).not.toHaveBeenCalled();
  });

  it("refuses a major-mismatched live head per connection", async () => {
    const services = versionGateServices({ liveHead: OTHER_MAJOR_HEAD });
    const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());

    for (const room of [liveDocumentName]) {
      const context = connectContext(COLLAB_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onConnect?.({
          documentName: room,
          context,
          connectionConfig: connectionConfig(),
        } as never),
      ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4407,
        reason: "document-schema-stale",
      });
    }
  });

  it("prioritizes a server-stale head over an even older client", async () => {
    const hocuspocus = createHocuspocus(
      versionGateServices({ liveHead: OTHER_MAJOR_HEAD }) as never,
      createYjsRoomAccessIndex(),
    );
    const context = connectContext(SENTINEL_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onConnect?.({
        connectionConfig: connectionConfig(),
        documentName: liveDocumentName,
        context,
      } as never),
    ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
    expect(context.closeTransport).toHaveBeenCalledWith({
      code: 4407,
      reason: "document-schema-stale",
    });
  });

  it.each([["live", liveDocumentName]])(
    "keeps the typed stale-head close on the %s document-load guard",
    async (_kind, room) => {
      const services = versionGateServices({ liveHead: null });
      Object.assign(services.documentSync, {
        loadHocuspocusDocument: vi.fn(async () => {
          throw staleSchemaError();
        }),
      });
      const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
      const context = connectContext(COLLAB_SCHEMA_VERSION);

      await expect(
        hocuspocus.configuration.onLoadDocument?.({
          documentName: room,
          document: new Y.Doc({ gc: false }),
          context,
        } as never),
      ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4407,
        reason: "document-schema-stale",
      });
    },
  );
});
