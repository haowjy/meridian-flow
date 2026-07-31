/**
 * WikilinkMenu — the documents `[[` offers (§5.5, mockup 06 state D).
 *
 * Rows and nothing else: the physics are `SuggestionMenu`'s, shared with the
 * slash menu, and what a row says is `ReferenceRow`'s, shared with `@` — a
 * document a writer reached through two doors has to read the same through
 * both. What is left here is the one row that is not a match: the page nobody
 * has written yet, under its own rule.
 */

import { useSyncExternalStore } from "react";

import { closedSuggestionMenu } from "@/core/completion";
import { getWikilinkMenu, type WikilinkItem } from "@/core/editor/extensions/wikilink";

import { type EditorChromeSurfaceProps, SuggestionMenu } from "../../chrome";
import { ReferenceRow } from "./reference-rows";

const NO_SUBSCRIPTION = () => () => {};
const closed = () => closedSuggestionMenu<WikilinkItem>();

export function WikilinkMenu({ editor }: EditorChromeSurfaceProps) {
  const menu = getWikilinkMenu(editor);
  const snapshot = useSyncExternalStore(
    menu?.subscribe ?? NO_SUBSCRIPTION,
    () => menu?.snapshot() ?? closed(),
    closed,
  );
  if (!menu) return null;

  return (
    <SuggestionMenu
      editor={editor}
      id="wikilink-menu"
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
        before:
          // The last row is a different kind of answer: everything above it
          // exists, and it does not yet.
          item.kind === "create" && index > 0 ? (
            <div className="my-1 border-border-subtle border-t" />
          ) : undefined,
        content: <ReferenceRow item={item} />,
      }))}
    />
  );
}
