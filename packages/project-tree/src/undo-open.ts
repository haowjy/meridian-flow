import type { Actor } from "./record.js";
import { undoChange as undo, type undoChange as undoChangeIn } from "./undo.js";
import type { View } from "./view.js";
import type { TreeWriter } from "./writer.js";

export const undoChange = (writer: TreeWriter, view: View, actor: Actor, id: string) =>
  undo(writer, view, actor, id, () => false) as Exclude<
    ReturnType<typeof undoChangeIn>,
    { closed: string }
  >;
