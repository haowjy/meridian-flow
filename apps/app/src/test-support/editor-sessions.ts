/** Instance-owned detached document sessions. Production owns snapshots and lifecycle. */
import { DocumentSession } from "@/core/editor/document-session";

export function createEditorSessions() {
  const sessions = new Map<string, DocumentSession>();
  const get = (roomKey: string) => {
    let session = sessions.get(roomKey);
    if (!session) {
      session = new DocumentSession({ roomKey, persistence: { kind: "none" } });
      sessions.set(roomKey, session);
    }
    return session;
  };
  return {
    get,
    registry: {
      get,
      getRoom: get,
      has: (roomKey: string) => sessions.has(roomKey),
      retain: () => {},
      release: () => {},
      retainBranchRooms: () => {},
      releaseBranchRooms: () => {},
      getBranchRoom: get,
    },
    async dispose() {
      await Promise.all([...sessions.values()].map((session) => session.destroy()));
      sessions.clear();
    },
  };
}
