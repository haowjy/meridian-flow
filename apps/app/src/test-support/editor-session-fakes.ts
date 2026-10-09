/**
 * Fake document sessions and a branch-room registry for suites that claim which
 * editor exists, and when (`EditorView`'s lifetime and review transitions). A
 * session is a real Y.Doc with real awareness behind a snapshot a test drives:
 * a schema fence, a connection state, a refused room that rebuilds, and the
 * persistence and first-sync horizons a mount waits on. Nothing here knows about
 * review; the suites own their controller.
 */
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type {
  DocumentSession,
  DocumentSessionConnectionState,
  DocumentSessionSnapshot,
  SchemaFence,
} from "@/core/editor/document-session";
import { createLocalPresence } from "@/core/editor/local-presence";
import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";
import { SessionMarkerStore } from "@/core/editor/session-marker-store";

const sessions = new Map<string, DocumentSession>();
export const sessionSnapshots = new Map<string, DocumentSessionSnapshot>();
const sessionListeners = new Map<string, Set<(snapshot: DocumentSessionSnapshot) => void>>();
export const sessionHorizons = new Map<
  string,
  { localPersistence: Promise<void>; firstServerSync: Promise<void> }
>();

/** Rooms whose pending edits the server refused: the review rebuilds them from server state. */
export const refusedRooms = new Set<string>();
let rebuild: { resolve: (session: DocumentSession) => void; reject: () => void } | null = null;

export function sessionFor(roomKey: string): DocumentSession {
  const existing = sessions.get(roomKey);
  if (existing) return existing;
  const doc = new Y.Doc({ gc: false });
  const awareness = new Awareness(doc);
  const snapshot: DocumentSessionSnapshot = {
    documentId: roomKey,
    roomKey,
    room: { kind: "live", documentId: roomKey },
    status: "detached",
    serverHasLocalChanges: false,
    connectionState: null,
    access: "edit",
    localPersistenceSynced: true,
    adoptionStalled: false,
    schemaFence: null,
    schemaRepairs: [],
  };
  const listeners = new Set<(next: DocumentSessionSnapshot) => void>();
  sessionSnapshots.set(roomKey, snapshot);
  sessionListeners.set(roomKey, listeners);
  const session = {
    roomKey,
    document: doc,
    awareness,
    presence: createLocalPresence(awareness),
    markerStore: new SessionMarkerStore("writer"),
    refusedLocalEdits: () => refusedRooms.has(roomKey),
    whenLocalPersistenceSynced: () =>
      sessionHorizons.get(roomKey)?.localPersistence ?? Promise.resolve(),
    whenSynced: () => sessionHorizons.get(roomKey)?.firstServerSync ?? Promise.resolve(),
    reportSchemaRepair: (event: SchemaRepairEvent) => {
      const current = sessionSnapshots.get(roomKey) ?? snapshot;
      const next = { ...current, schemaRepairs: [...current.schemaRepairs, event] };
      sessionSnapshots.set(roomKey, next);
      for (const listener of listeners) listener(next);
    },
    getSnapshot: () => sessionSnapshots.get(roomKey) ?? snapshot,
    subscribe: (listener: (next: DocumentSessionSnapshot) => void) => {
      listeners.add(listener);
      listener(sessionSnapshots.get(roomKey) ?? snapshot);
      return () => listeners.delete(listener);
    },
  } as unknown as DocumentSession;
  sessions.set(roomKey, session);
  return session;
}

export function raiseSchemaFence(roomKey: string, fence: SchemaFence): void {
  const snapshot = sessionSnapshots.get(roomKey);
  if (!snapshot || snapshot.schemaFence) return;
  const fenced = { ...snapshot, schemaFence: fence };
  sessionSnapshots.set(roomKey, fenced);
  for (const listener of sessionListeners.get(roomKey) ?? []) listener(fenced);
}

export function setConnectionState(
  roomKey: string,
  connectionState: DocumentSessionConnectionState,
): void {
  const snapshot = sessionSnapshots.get(roomKey);
  if (!snapshot) return;
  const next = { ...snapshot, connectionState };
  sessionSnapshots.set(roomKey, next);
  for (const listener of sessionListeners.get(roomKey) ?? []) listener(next);
}

export function setSessionStatus(roomKey: string, status: DocumentSessionSnapshot["status"]): void {
  const snapshot = sessionSnapshots.get(roomKey);
  if (!snapshot) return;
  const next = { ...snapshot, status };
  sessionSnapshots.set(roomKey, next);
  for (const listener of sessionListeners.get(roomKey) ?? []) listener(next);
}

/** A fresh session for `roomKey`: the rebuild's result once the server state has synced. */
export function finishRebuild(roomKey: string): void {
  refusedRooms.delete(roomKey);
  sessions.delete(roomKey);
  rebuild?.resolve(sessionFor(roomKey));
  rebuild = null;
}

export function failRebuild(): void {
  rebuild?.reject();
  rebuild = null;
}

/** The live document-session registry as `EditorView` reads it; branch rooms are the same fakes. */
export const registry = {
  rebuildBranchRoom: () =>
    new Promise<DocumentSession>((resolve, reject) => {
      rebuild = { resolve, reject };
    }),
  retain: () => {},
  release: () => {},
  getRoom: sessionFor,
  has: () => false,
  get: sessionFor,
  retainBranchRooms: () => {},
  releaseBranchRooms: () => {},
  getBranchRoom: sessionFor,
};
