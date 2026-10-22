/**
 * Writer-facing copy for a `move` or `delete` the server refused, worded from the typed cause
 * on its result (`refusal`), never from the model's message. A place is named whole
 * ("Manuscript/part2/note"), so the writer can find what stands in the way, and an occupied
 * place is "taken": the refusal doesn't say whether a document or a folder is there.
 */
import { t } from "@lingui/core/macro";
import type { NamespaceRefusal } from "@meridian/agent-edit";
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
  if (command !== "move" && command !== "delete") return null;
  const path = stringInput(input, "path");
  const from = command === "move" ? sourcePath(input) : path;
  if (!from) return null;
  const source = documentDisplayName(from);
  const place = command === "move" && path ? documentLocationName(path, names) : null;
  switch (refusal as NamespaceRefusal | null) {
    case "source_is_folder":
      return t`${source} is a folder. Only documents can be moved or deleted.`;
    case "document_unresolved":
      return t`Couldn't find ${source}.`;
    case "location_taken":
      return place
        ? t`Can't move ${source}: ${place} is already taken.`
        : t`Can't move ${source}: that location is already taken.`;
    case "destination_missing":
      return place
        ? t`Can't move ${source}: the folder for ${place} doesn't exist.`
        : t`Can't move ${source}: that folder doesn't exist.`;
    case "stale_location":
      return command === "move"
        ? t`Can't move ${source}: it or its destination changed during the move.`
        : t`Can't delete ${source}: it changed during the delete.`;
    case "already_at_destination":
      return place ? t`${source} is already at ${place}.` : t`${source} is already there.`;
    case "file_type_conversion":
      return t`Can't move ${source}: renaming it can't change its file type.`;
    case "document_type_conversion":
      return t`Can't move ${source}: that extension needs a different kind of document.`;
    case "unsupported":
      return command === "move"
        ? t`Can't move ${source} to that location.`
        : t`Can't delete ${source} from this location.`;
    default:
      return null;
  }
}
