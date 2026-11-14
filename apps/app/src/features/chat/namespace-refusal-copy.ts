/**
 * Writer-facing copy for a tree command the server refused, worded from the typed cause
 * on its result (`refusal`), never from the model's message. A place is named whole
 * ("Manuscript/part2/note"), so the writer can find what stands in the way, and an occupied
 * place is "taken": the refusal doesn't say whether a document or a folder is there.
 */
import { t } from "@lingui/core/macro";
import type { JsonValue } from "@meridian/contracts/protocol";
import { sourcePath, stringInput } from "@meridian/thread-client";
import {
  documentDisplayName,
  documentLocationName,
  type OwnerNames,
} from "./document-display-name";

/** The sentence for a refused move or delete, or null when the result carries no known cause. */
export function namespaceRefusalCopy(
  input: Record<string, JsonValue>,
  refusal: string | null,
  names?: OwnerNames,
): string | null {
  const command = stringInput(input, "command");
  if (command !== "move" && command !== "delete" && command !== "restore") return null;
  const path = stringInput(input, "path");
  const from = command === "move" ? sourcePath(input) : path;
  if (!from) return null;
  const source = documentDisplayName(from);
  const place = command === "move" && path ? documentLocationName(path, names) : null;
  switch (refusal) {
    case "target_gone":
      return t`${source} was deleted after the AI last listed it.`;
    case "would_loop":
      return t`Can't move ${source}: it would go inside itself.`;
    case "path_changed":
      return t`The AI's path for ${source} now names a different document, so nothing was done.`;
    case "already_at_destination":
      return place ? t`${source} is already at ${place}.` : t`${source} is already there.`;
    default:
      return null;
  }
}
