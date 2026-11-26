import { useSyncExternalStore } from "react";
import { role } from "@/components/ui/roles";
import { closedSuggestionMenu } from "@/core/completion";
import {
  getSlashMenu,
  type SlashCommandItem,
  type SlashMenuMeta,
} from "@/core/editor/extensions/slash";
import { cn } from "@/lib/utils";

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
  const grouped = snapshot.query === "" && groupLabels !== null;

  return (
    <SuggestionMenu
      editor={editor}
      typingElement={editor.view.dom}
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
            <div className={cn("px-2 pt-2 pb-1", role.groupLabel)}>{groupLabels[item.group]}</div>
          ) : undefined,
        content: <SlashRow item={item} />,
        note: item.hint,
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
    </>
  );
}
