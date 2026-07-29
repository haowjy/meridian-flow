/**
 * SlashMenu — the list `/` opens (§5.7, mockup 07).
 *
 * Rows and nothing else. The physics the writer feels — focus staying in the
 * prose, the eight-row cap, the scroll that follows the arrow keys, the fades
 * — belong to `SuggestionMenu`, which the `[[` menu shares; this file decides
 * what a slash row says and when a group heading opens.
 */

import { useSyncExternalStore } from "react";

import {
  getSlashMenu,
  type SlashCommandItem,
  type SlashMenuMeta,
} from "@/core/editor/extensions/slash";
import { closedSuggestionMenu } from "@/core/editor/extensions/suggestion";

import { type EditorChromeSurfaceProps, SuggestionMenu } from "../../chrome";
import { SLASH_MENU_ICONS } from "./slash-menu-icons";

const NO_SUBSCRIPTION = () => () => {};
const closed = () => closedSuggestionMenu<SlashCommandItem, SlashMenuMeta>();

export function SlashMenu({ editor }: EditorChromeSurfaceProps) {
  const menu = getSlashMenu(editor);
  const snapshot = useSyncExternalStore(
    menu?.subscribe ?? NO_SUBSCRIPTION,
    () => menu?.snapshot() ?? closed(),
    closed,
  );
  if (!menu) return null;

  const groupLabels = snapshot.meta?.groupLabels ?? null;
  // Group headings answer "what is in this menu"; a filtered list is already
  // an answer, and the mockup's state B drops them (they would also fragment,
  // since matches sort by score rather than by group).
  const grouped = snapshot.query === "" && groupLabels !== null;

  return (
    <SuggestionMenu
      editor={editor}
      id="slash-menu"
      open={snapshot.open}
      label={snapshot.label}
      anchorRect={snapshot.anchorRect}
      activeIndex={snapshot.activeIndex}
      onActivate={(index) => menu.setActiveIndex(index)}
      onChoose={(index) => menu.choose(index)}
      onDismiss={() => menu.dismiss()}
      rows={snapshot.items.map((item, index) => ({
        key: item.id,
        before:
          grouped && groupLabels && item.group !== snapshot.items[index - 1]?.group ? (
            <div className="px-2 pt-2 pb-1 font-semibold text-ink-subtle text-xs uppercase tracking-wider">
              {groupLabels[item.group]}
            </div>
          ) : undefined,
        content: <SlashRow item={item} />,
      }))}
    />
  );
}

function SlashRow({ item }: { item: SlashCommandItem }) {
  const Icon = SLASH_MENU_ICONS[item.id];
  return (
    <>
      <Icon aria-hidden />
      <span>{item.label}</span>
      {item.hint ? <span className="ml-auto pl-4 text-ink-subtle text-xs">{item.hint}</span> : null}
    </>
  );
}
