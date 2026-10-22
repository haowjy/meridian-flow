/**
 * Writer-facing copy for a `move` or `delete` the server refused, worded from the typed cause
 * on its result (`refusal`), never from the model's message.
 */
import { t } from "@lingui/core/macro";
import type { NamespaceRefusal } from "@meridian/agent-edit";
import type { JsonValue } from "@meridian/contracts/protocol";
import { sourcePath, stringInput } from "@meridian/thread-client";
import { documentDisplayName, moveDestinationName } from "./document-display-name";

/** The sentence for a refused move or delete, or null when the result carries no known cause. */
export function namespaceRefusalCopy(
  input: Record<string, JsonValue>,
  refusal: string | null,
): string | null {
  const command = stringInput(input, "command");
  if (command !== "move" && command !== "delete") return null;
  const path = stringInput(input, "path");
  const from = command === "move" ? sourcePath(input) : path;
  if (!from) return null;
  const source = documentDisplayName(from);
  const place = command === "move" && path ? moveDestinationName(from, path) : null;
  switch (refusal as NamespaceRefusal | null) {
    case "source_is_folder":
      return t`${source} is a folder. Only documents can be moved or deleted.`;
    case "document_unresolved":
      return t`Couldn't find ${source}.`;
    case "location_taken":
      return place
        ? t`Can't move ${source}: another document is at ${place}.`
        : t`Can't move ${source}: another document is already there.`;
    case "destination_missing":
      return place
        ? t`Can't move ${source}: the folder for ${place} doesn't exist.`
        : t`Can't move ${source}: that folder doesn't exist.`;
    case "stale_location":
      return command === "move"
        ? t`Can't move ${source}: it or its destination changed at the same time.`
        : t`Can't delete ${source}: it changed at the same time.`;
    case "already_at_destination":
      return place ? t`${source} is already at ${place}.` : t`${source} is already there.`;
    case "file_type_conversion":
      return t`Can't move ${source}: the new name would change its file type.`;
    case "document_type_conversion":
      return t`Can't move ${source}: the new name needs a different kind of document.`;
    case "mixed_modes":
      return t`Can't move ${source}: this chat is in draft mode, so this move would be half drafted and half live.`;
    case "unsupported":
      return command === "move" ? t`Can't move ${source} there.` : t`Can't delete ${source} here.`;
    default:
      return null;
  }
}
