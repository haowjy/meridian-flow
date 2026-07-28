/** Connect-time schema compatibility behavior for live and Work-draft Yjs rooms. */
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  formatCollabSchemaSubprotocol,
} from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import { messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { DocumentSchemaMajorMismatchError } from "../../domains/collab/index.js";
import { clientSchemaVersionFromRequest, createHocuspocus } from "../yjs-ws-handler.js";

const branchRoomName = "branch:branch_1:gen:3";
const liveDocumentName = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";
const version = (major: number, minor: number, patch = 0): CollabSchemaVersion => ({
  major,
  minor,
  patch,
});
const SENTINEL_SCHEMA_VERSION = version(0, 0, 0);

function versionGateServices(
  input: {
    liveHead?: CollabSchemaVersion | null;
    branchHead?: CollabSchemaVersion;
    liveGeneration?: bigint;
  } = {},
) {
  const documentSync = {
    bindHocuspocus: vi.fn(),
    headSchemaVersion: vi.fn(async () => (input.liveHead === undefined ? null : input.liveHead)),
    resolveBranchHocuspocusRoom: vi.fn(async (branchId: string, generation: number) => ({
      branchId,
      documentId: liveDocumentName,
      generation,
      schemaVersion: input.branchHead ?? COLLAB_SCHEMA_VERSION,
      status: "active" as const,
    })),
    resolveManifestMembership: vi.fn(async () => ({
      documentId: liveDocumentName,
      members: [liveDocumentName],
    })),
    reconcileProjectManifest: vi.fn(async () => undefined),
    currentLiveGeneration: vi.fn(async () => input.liveGeneration ?? 1n),
    admitLiveWriterUpdate: vi.fn(async () => ({
      admitted: true as const,
      joinedSettlement: false,
    })),
    flushBranchLivePull: vi.fn(async () => undefined),
  };
  return {
    documentAccess: {
      canAccessDocument: vi.fn(async () => true),
      projectIdForDocument: vi.fn(async () => "00000000-0000-4000-8000-000000000103"),
    },
    documentSync,
    eventSink: { emit() {} },
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
    version(1, 0),
    COLLAB_SCHEMA_VERSION,
  );
}

describe("Yjs connect-time schema version gate", () => {
  it("extracts the client version from a sole matching subprotocol offer", () => {
    expect(
      clientSchemaVersionFromRequest(
        new Request("https://meridian.local/ws/yjs", {
          headers: {
            "sec-websocket-protocol": `unrelated, ${formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION)}`,
          },
        }),
      ),
    ).toEqual(COLLAB_SCHEMA_VERSION);
  });

  it("ignores a residual schema query parameter instead of using it as a fallback", () => {
    expect(
      clientSchemaVersionFromRequest(
        new Request(
          `https://meridian.local/ws/yjs?schema=${COLLAB_SCHEMA_VERSION.major}.${COLLAB_SCHEMA_VERSION.minor}.${COLLAB_SCHEMA_VERSION.patch}`,
        ),
      ),
    ).toEqual(SENTINEL_SCHEMA_VERSION);
  });

  it("refuses only live-room clients strictly older than a stored head", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    const hocuspocus = createHocuspocus(services as never);
    const staleClientContext = connectContext(SENTINEL_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onConnect?.({
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
        documentName: liveDocumentName,
        context: connectContext(COLLAB_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
    expect(services.documentSync.headSchemaVersion).toHaveBeenCalledTimes(2);
    expect(services.documentSync.headSchemaVersion).toHaveBeenCalledWith(liveDocumentName);
  });

  it("passes a live room with no stamped head, including an absent-version client", async () => {
    const hocuspocus = createHocuspocus(versionGateServices({ liveHead: null }) as never);

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: liveDocumentName,
        context: connectContext(SENTINEL_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
  });

  it("carries the admitted live generation through the sync hook", async () => {
    const services = versionGateServices({
      liveHead: COLLAB_SCHEMA_VERSION,
      liveGeneration: 9n,
    });
    const hocuspocus = createHocuspocus(services as never);
    const context = connectContext(COLLAB_SCHEMA_VERSION);
    const document = new Y.Doc({ gc: false });
    const payload = new Uint8Array([1, 2, 3]);

    await hocuspocus.configuration.onConnect?.({
      documentName: liveDocumentName,
      context,
    } as never);
    await hocuspocus.configuration.beforeSync?.({
      documentName: liveDocumentName,
      document,
      type: messageYjsUpdate,
      payload,
      context,
    } as never);

    expect(services.documentSync.admitLiveWriterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: liveDocumentName,
        expectedGeneration: 9n,
      }),
    );
  });

  it("rejects sync when the admitted target does not match the message room", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    const hocuspocus = createHocuspocus(services as never);
    const context = connectContext(COLLAB_SCHEMA_VERSION);

    await hocuspocus.configuration.onConnect?.({
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

  it("gates branch rooms at the same strict monotonic edge", async () => {
    const hocuspocus = createHocuspocus(
      versionGateServices({ branchHead: COLLAB_SCHEMA_VERSION }) as never,
    );
    const staleClientContext = connectContext(SENTINEL_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: branchRoomName,
        context: staleClientContext,
      } as never),
    ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
    expect(staleClientContext.closeTransport).toHaveBeenCalledWith({
      code: 4406,
      reason: "client-schema-superseded",
    });
    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: branchRoomName,
        context: connectContext(COLLAB_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
  });

  it("refuses major-mismatched live and branch heads per connection", async () => {
    const majorMismatchHead = version(1, 0);
    const services = versionGateServices({
      liveHead: majorMismatchHead,
      branchHead: majorMismatchHead,
    });
    const hocuspocus = createHocuspocus(services as never);

    for (const room of [liveDocumentName, branchRoomName]) {
      const context = connectContext(COLLAB_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onConnect?.({ documentName: room, context } as never),
      ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4407,
        reason: "document-schema-stale",
      });
    }
  });

  it("prioritizes a server-stale head over an even older client", async () => {
    const hocuspocus = createHocuspocus(versionGateServices({ liveHead: version(1, 0) }) as never);
    const context = connectContext(SENTINEL_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: liveDocumentName,
        context,
      } as never),
    ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
    expect(context.closeTransport).toHaveBeenCalledWith({
      code: 4407,
      reason: "document-schema-stale",
    });
  });

  it("maps a stale manifest dependency to the same typed close", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    services.documentSync.resolveManifestMembership.mockRejectedValue(staleSchemaError());
    const hocuspocus = createHocuspocus(services as never);
    const context = connectContext(COLLAB_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: liveDocumentName,
        context,
      } as never),
    ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
    expect(context.closeTransport).toHaveBeenCalledWith({
      code: 4407,
      reason: "document-schema-stale",
    });
  });

  it.each([
    ["live", liveDocumentName],
    ["branch", branchRoomName],
  ])("keeps the typed stale-head close on the %s document-load guard", async (_kind, room) => {
    const services = versionGateServices({ liveHead: null });
    Object.assign(services.documentSync, {
      loadHocuspocusDocument: vi.fn(async () => {
        throw staleSchemaError();
      }),
      loadHocuspocusBranchState: vi.fn(async () => {
        throw staleSchemaError();
      }),
    });
    const hocuspocus = createHocuspocus(services as never);
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
  });
});
