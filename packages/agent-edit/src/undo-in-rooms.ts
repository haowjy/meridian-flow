import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import {
  type DocChange,
  type EditStayed,
  type RoomDocs,
  type StoredEdit,
  undoEdits,
} from "@meridian/document-model";

/** An AI write as an Undo takes it back: its edit, in the room it landed in. */
export interface RoomPart {
  room: DocumentRoom;
  edit: StoredEdit;
}

/**
 * Takes `parts` back, newest first as given, each in the room it landed in (design §5), by design
 * §2's Undo rule (`undoEdits`), one room's parts judged together on what the ones before them
 * left. `docsOf` gives each room's copy, which the caller holds, commits from and frees. Returns
 * each room's changes, committed in its copy, and why each part that stayed did.
 */
export function undoInRooms<P extends RoomPart>(
  parts: readonly P[],
  docsOf: (room: DocumentRoom) => RoomDocs,
  message?: string,
): { rooms: { room: DocumentRoom; changes: DocChange[] }[]; stayed: Map<P, EditStayed> } {
  const byRoom = new Map<string, { room: DocumentRoom; here: P[] }>();
  for (const part of parts) {
    const name = loroRoomName(part.room);
    const group = byRoom.get(name) ?? { room: part.room, here: [] };
    group.here.push(part);
    byRoom.set(name, group);
  }
  const rooms: { room: DocumentRoom; changes: DocChange[] }[] = [];
  const stayed = new Map<P, EditStayed>();
  for (const { room, here } of byRoom.values()) {
    const { changes, stayed: why } = undoEdits(
      docsOf(room),
      here.map((part) => part.edit),
      message,
    );
    for (const [index, reason] of why) stayed.set(here[index], reason);
    if (changes.length) rooms.push({ room, changes });
  }
  return { rooms, stayed };
}
