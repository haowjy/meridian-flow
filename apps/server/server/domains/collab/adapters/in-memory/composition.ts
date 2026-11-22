/** Explicit in-memory collab composition and behavior-preserving unsupported stubs. */

import {
  agentEditRooms,
  type LoroDocumentEdits,
  type WriteOrdinals,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import {
  createMemoryDocumentRooms,
  type MemoryDocumentRooms,
} from "@meridian/document-model/rooms";
import { shapeSchemaOf } from "@meridian/loro-prosemirror";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { DrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { createCollabFacade } from "../../collab-facade.js";
import type { CollabDomain, CollabDrafts, ServerDocumentRooms } from "../../contracts.js";
import { createAgentEditRouter } from "../../domain/agent-edit-router.js";
import { createAgentEditRuntime } from "../../domain/agent-edit-runtime.js";
import { createDocumentCreationAggregate } from "../../domain/document-creation.js";
import { createDocumentWriteHookRunner } from "../../domain/document-projection-refresher.js";
import { createDrafts } from "../../domain/drafts.js";
import { createEffectiveDocumentReader } from "../../domain/effective-document-reader.js";
import { createTurnLiveLineageReadModel } from "../../domain/turn-live-lineage.js";
import { createAgentEditObservabilityOptions } from "../agent-edit-observability.js";
import {
  SILENT_DOCUMENT_PROJECTION_DIAGNOSTICS,
  UNSUPPORTED_REVERSE_THREAD_CONTEXT,
} from "../declared-stubs.js";
import {
  createInMemoryDraftStore,
  createInMemoryDraftWriteBoundary,
  type NamedDraft,
} from "./drafts.js";
import {
  createStaticDocumentLinkScopes,
  UNSUPPORTED_AHEAD_REFS,
} from "./static-document-link-scopes.js";

/** `namedDraft` reads the draft a Work's or root chat's row names; by default nothing names one. */
export function createInMemoryCollabDomain(
  namedDraft: NamedDraft = async () => null,
): CollabDomain {
  // Nothing in memory carries a filetype: every document is prose.
  const resolveDocumentFiletype = async () => null;
  const schema = buildDocumentSchema();
  const memory = createMemoryDocumentRooms(shapeSchemaOf(schema));
  const documentCreation = createDocumentCreationAggregate({
    atomic: (operation) => operation(),
  });
  const runDocumentWriteHook = createDocumentWriteHookRunner({
    hook: async () => {},
    diagnostics: SILENT_DOCUMENT_PROJECTION_DIAGNOSTICS,
  });
  const links = createStaticDocumentLinkScopes();
  const serverRooms = memoryServerRooms(memory);
  const runtime = createAgentEditRuntime({
    loro: {
      rooms: agentEditRooms(serverRooms, {
        roomFor: async (documentId) => ({ kind: "live", documentId }),
        // The memory rooms run each commit as its own transaction.
        transaction: () => null as unknown as DrizzleDb,
        origin: "server:agent",
        // Nothing in memory keeps an edit history.
        recordWrite: async () => {},
      }),
      ordinals: inMemoryWriteOrdinals(),
      documentEdits: NO_EDIT_HISTORY,
      authorOfTurn: async () => null,
    },
    links,
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    inTransaction: () => false,
    rooms: memory,
    transaction: (work) => memory.transaction(work),
    lockDocument: async () => {},
    runDocumentWriteHook,
    resolveDocumentFiletype,
    observability: createAgentEditObservabilityOptions({}),
  });
  const drafts = createDrafts({
    store: createInMemoryDraftStore(namedDraft),
    boundary: createInMemoryDraftWriteBoundary(),
  });
  const agentEdit = createAgentEditRouter({ liveCore: runtime.liveCore });
  const projections = { refresh: runDocumentWriteHook };
  const lineage = createTurnLiveLineageReadModel({
    store: IN_MEMORY_TURN_LIVE_LINEAGE,
    resolveDocumentUri: async (documentId) => documentId,
    resolveLastDocumentUri: async (documentId) => documentId,
  });

  return createCollabFacade({
    importBinder: runtime.importBinder,
    lifecycle: { dispose: async () => {} },
    transport: {
      rooms: serverRooms,
      documentSchemaVersion: async () => null,
      onRoomsEnded: () => () => undefined,
      // Nothing is removed in memory.
      draftsHolding: async () => [],
      roomRemoval: async () => null,
    },
    agentEdit: {
      agentEdit: () => agentEdit,
      modelEdits: () => {
        throw new Error("Model edits require the command-backed Postgres adapter");
      },
      modelEvidence: () => {
        throw new Error("Model evidence requires the Postgres adapter");
      },
      treeHistory: () => {
        throw new Error("Tree history requires the receipt-backed Postgres adapter");
      },
    },
    reversal: {
      reverseTurn: async () => {
        throw new Error("Turn receipts require the durable Postgres receipt adapter");
      },
      reverseThreadContext: UNSUPPORTED_REVERSE_THREAD_CONTEXT,
    },
    documents: {
      readForExport: runtime.markdownDocuments.readForExport,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      readVersionedMarkdown: runtime.markdownDocuments.readVersionedMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      async endDocumentRooms() {},
      encodeSeed: runtime.markdownDocuments.encodeSeed,
      installSeeds: runtime.markdownDocuments.installSeeds,
      writeDocument: runtime.markdownDocuments.writeDocument,
      mergeCodeText: runtime.markdownDocuments.mergeCodeText,
      bindMarkdown: runtime.linkBinder.bindMarkdown,
      bindCopiedBlocks: runtime.linkBinder.bindCopiedBlocks,
      bindStatic: runtime.linkBinder.bindStatic,
    },
    projections: {
      refreshDocumentProjection: projections.refresh,
      documentDerivations: {
        derive: async (documentId) => {
          await projections.refresh({ documentId });
          return { status: "missing" };
        },
        schedule: () => {},
        sweep: async () => 0,
        stop: async () => {},
      },
    },
    lineage,
    effectiveReader: {
      ...createEffectiveDocumentReader({
        // Nothing is derived in memory.
        blockText: { grepTexts: async () => new Map(), wordCounts: async () => new Map() },
        documents: runtime.markdownDocuments,
        schema,
        codec: runtime.codec,
        links,
        resolveFiletype: resolveDocumentFiletype,
      }),
      async writeWorkCreatedContent() {
        throw new Error("Work creates need Postgres; the in-memory collab domain has no drafts");
      },
    },
    drafts: createInMemoryDraftStub(),
    draftResolver: {
      drafts,
      // No drafts in memory: a purged Work has none to dispose of.
      workDraftDisposal: {
        withDisposal: (_workId, run) => run(async () => ({ releasedObjects: [], draftIds: [] })),
      },
      documentPurgeDisposal: { settle: async () => "closed" },
    },
    documentCreation,
  });
}

function createInMemoryDraftStub(): CollabDrafts {
  const unsupported = async (): Promise<never> => {
    throw new Error("The press needs Postgres; the in-memory collab domain has no Works");
  };
  return {
    presses: { press: unsupported, undo: unsupported },
    draftReview: {
      async purgeDiscards() {
        return 0;
      },
      async list() {
        return [];
      },
      async listItems() {
        return { items: [], folders: [], threadTitles: new Map(), saw: {} };
      },
      async pendingDocumentCount() {
        return 0;
      },
      async draftsChangingDocument() {
        return [];
      },
      async items({ draft }) {
        return { draftId: draft, items: [] };
      },
      async resolveItem() {
        return null;
      },
      async resolveItemInDraft() {
        return null;
      },
      async lookupCommand() {
        return { kind: "none" };
      },
      async awaitCommand() {
        return { kind: "none" };
      },
    },
  };
}

/** Nothing in memory keeps an edit history, so no turn edited anything. */
const IN_MEMORY_TURN_LIVE_LINEAGE = {
  async listLiveDocumentIdsForTurn(): Promise<DocumentId[]> {
    return [];
  },
  async listEditedDocumentIdsForTurn(): Promise<{ documentId: DocumentId; scope: "live" }[]> {
    return [];
  },
  async listFolderTargetsForTurn() {
    return [];
  },
  async placesOf() {
    return new Map();
  },
  async listTreeEntriesForTurn() {
    return [];
  },
};

/** Ordinals per document and chat, for this composition's life. */
function inMemoryWriteOrdinals(): WriteOrdinals {
  const next = new Map<string, number>();
  return {
    async reserveWriteOrdinal(documentId, threadId) {
      const key = `${documentId}\0${threadId}`;
      const ordinal = (next.get(key) ?? 0) + 1;
      next.set(key, ordinal);
      return ordinal;
    },
  };
}

const NO_EDIT_HISTORY: LoroDocumentEdits = {
  read: async () => ({ status: "invalid_write", message: "This host has no edit history." }),
  execute: async () => ({ status: "invalid_write", message: "This host has no edit history." }),
};

/** The in-memory rooms behind the server's door: each commit or seed is its own transaction. */
function memoryServerRooms(memory: MemoryDocumentRooms): ServerDocumentRooms {
  return {
    read: memory.read,
    sync: memory.sync,
    write: memory.write,
    commit: (_tx, room, batch, origin) =>
      memory.transaction((tx) => memory.commit(tx, room, batch, origin)),
    seed: (_tx, room, snapshots) => memory.transaction((tx) => memory.seed(tx, room, snapshots)),
    subscribe: memory.subscribe,
    flush: memory.flush,
    unload: memory.unload,
    close: memory.close,
  };
}
