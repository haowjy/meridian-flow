import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import {
  type CommitAuthor,
  type DocChange,
  type RoomDocs,
  type StoredEdit,
  undoEdits,
} from "@meridian/document-model";

export interface RoomPart {
  room: DocumentRoom;
  edit: StoredEdit;
}

export function undoInRooms<P extends RoomPart>(
  parts: readonly P[],
  docsOf: (room: DocumentRoom) => RoomDocs,
  by?: CommitAuthor,
): { rooms: { room: DocumentRoom; changes: DocChange[] }[]; compacted: Set<P> } {
  const byRoom = new Map<string, { room: DocumentRoom; here: P[] }>();
  for (const part of parts) {
    const name = loroRoomName(part.room);
    const group = byRoom.get(name) ?? { room: part.room, here: [] };
    group.here.push(part);
    byRoom.set(name, group);
  }
  const rooms: { room: DocumentRoom; changes: DocChange[] }[] = [];
  const compacted = new Set<P>();
  for (const { room, here } of byRoom.values()) {
    const undone = undoEdits(
      docsOf(room),
      here.map((part) => part.edit),
      by,
    );
    for (const index of undone.compacted) compacted.add(here[index]);
    if (undone.changes.length) rooms.push({ room, changes: undone.changes });
  }
  return { rooms, compacted };
}
