/**
 * Composer `/` list. Group headings while the query is empty; Skills rows as
 * slug plus truncated description. Manuscript SlashMenu is a different host.
 */

import type { Editor } from "@tiptap/core";
import { useSyncExternalStore } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { closedSuggestionMenu } from "@/core/completion";
import { SuggestionMenu } from "@/features/editor/chrome";
import { cn } from "@/lib/utils";

import { type ComposerCommandMenuMeta, getComposerCommandMenu } from "./ComposerCommandExtension";
import type { ComposerCommandItem } from "./command-catalog";

const NO_SUBSCRIPTION = () => () => {};
const closed = () => closedSuggestionMenu<ComposerCommandItem, ComposerCommandMenuMeta>();

export function ComposerCommandMenu({ editor }: { editor: Editor }) {
  const menu = getComposerCommandMenu(editor);
  const snapshot = useSyncExternalStore(
    menu?.subscribe ?? NO_SUBSCRIPTION,
    () => menu?.snapshot() ?? closed(),
    closed,
  );
  if (!menu) return null;

  const groupLabels = snapshot.meta?.groupLabels ?? null;
  const grouped = snapshot.query === "" && groupLabels !== null;
  const shellRect = () => {
    const shell = editor.view.dom.closest("[data-composer]");
    return shell instanceof Element ? shell.getBoundingClientRect() : null;
  };

  return (
    <SuggestionMenu
      editor={editor}
      typingElement={editor.view.dom}
      id="composer-command-menu"
      open={snapshot.open}
      label={snapshot.label}
      anchorRect={shellRect}
      className="min-w-0 w-(--radix-popper-anchor-width)"
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
        content: <CommandRow item={item} />,
      }))}
    />
  );
}

function CommandRow({ item }: { item: ComposerCommandItem }) {
  const detail = item.name !== item.slug || Boolean(item.description);
  const row = (
    <span className="flex min-w-0 flex-1 items-baseline gap-4">
      <span className="shrink-0">{item.slug}</span>
      {item.description ? (
        <span className="min-w-0 flex-1 truncate text-ink-subtle text-xs">{item.description}</span>
      ) : null}
    </span>
  );
  if (!detail) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="top" className="pointer-events-none max-w-56">
        {item.name !== item.slug ? <span className="block">{item.name}</span> : null}
        {item.description ? (
          <span className={cn("block", item.name !== item.slug && "text-background/70")}>
            {item.description}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
