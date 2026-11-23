import { t } from "@lingui/core/macro";
import type { PressOverwriter } from "@meridian/contracts/drafts";
import { keptLabel } from "@/core/editor/extensions/KeptExtension";

/**
 * What a change a press's Undo left in place says of who wrote over it: you, a chat by its title
 * (its ref while the title is unknown), another press, or no one when the server names nobody.
 */
export function stayedLabel(
  by: readonly PressOverwriter[],
  chatTitle: (ref: string) => string | null,
): string {
  const [first] = by;
  if (!first) return keptLabel(undefined);
  if (first.kind === "writer") return keptLabel(t`You`);
  if (first.kind === "press") return keptLabel(t`Another Apply or Discard`);
  const title = chatTitle(first.ref);
  return keptLabel(title ? t`The chat “${title}”` : t`Chat ${first.ref}`);
}
