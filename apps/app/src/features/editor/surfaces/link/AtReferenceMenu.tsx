/**
 * AtReferenceMenu — what `@` offers: the pages and the pictures together.
 *
 * The physics are `SuggestionMenu`'s, shared with `[[` and the slash menu, and
 * the rows are `ReferenceRow`'s, shared with `[[`. What this file decides is
 * the one thing a mixed menu has to answer that a single-kind menu does not:
 * when the kinds are named out loud.
 *
 * They are named while the writer is browsing, and only then. An empty query
 * matches everything equally, so the ranking hands the kinds over already
 * gathered — every document, then everything standing beside them — and a
 * heading over each run is the answer to "what can `@` even do". The moment a
 * query narrows the list the headings go: matches sort by how well the name
 * fits rather than by kind, so a picture can and should outrank a chapter, and
 * headings over that list would fragment into a stutter. The icon carries the
 * kind from there on.
 */

import { useSyncExternalStore } from "react";

import { closedSuggestionMenu } from "@/core/completion";
import {
  type AtReferenceItem,
  type AtReferenceMeta,
  getAtReferenceMenu,
} from "@/core/editor/extensions/at-reference";

import { type EditorChromeSurfaceProps, SuggestionMenu } from "../../chrome";
import { ReferenceRow } from "./reference-rows";

const NO_SUBSCRIPTION = () => () => {};
const closed = () => closedSuggestionMenu<AtReferenceItem, AtReferenceMeta>();

export function AtReferenceMenu({ editor }: EditorChromeSurfaceProps) {
  const menu = getAtReferenceMenu(editor);
  const snapshot = useSyncExternalStore(
    menu?.subscribe ?? NO_SUBSCRIPTION,
    () => menu?.snapshot() ?? closed(),
    closed,
  );
  if (!menu) return null;

  const groupLabels = snapshot.query === "" ? snapshot.meta?.groupLabels : null;

  return (
    <SuggestionMenu
      editor={editor}
      id="at-reference-menu"
      open={snapshot.open}
      label={snapshot.label}
      anchorRect={snapshot.anchorRect}
      activeIndex={snapshot.activeIndex}
      onActivate={(index) => menu.setActiveIndex(index)}
      onChoose={(index) => menu.choose(index)}
      onDismiss={() => menu.dismiss()}
      className="max-w-96"
      rows={snapshot.items.map((item, index) => ({
        key: item.key,
        before: rowBefore(snapshot.items, index, groupLabels),
        content: <ReferenceRow item={item} />,
      }))}
    />
  );
}

/**
 * The heading a row opens a run of, or the rule above the row that is not a
 * match at all.
 */
function rowBefore(
  items: readonly AtReferenceItem[],
  index: number,
  groupLabels: AtReferenceMeta["groupLabels"] | null | undefined,
) {
  const item = items[index];
  const previous = items[index - 1];
  if (!item) return undefined;

  // The last row is a different kind of answer: everything above it exists,
  // and it does not yet.
  if (item.kind === "create") {
    return index > 0 ? <div className="my-1 border-border-subtle border-t" /> : undefined;
  }

  if (!groupLabels || item.kind === previous?.kind) return undefined;
  return (
    <div className="px-2 pt-2 pb-1 font-semibold text-ink-subtle text-xs uppercase tracking-wider">
      {groupLabels[item.kind]}
    </div>
  );
}
