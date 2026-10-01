/**
 * LinkPickerMenu — the documents `[[` offers (§5.5, mockup 06 state D).
 *
 * Rows and nothing else: the physics are `SuggestionMenu`'s, shared with the
 * slash menu, so a writer meets both the same way. What this file decides is
 * what a row says — the document's name, where it lives (so two documents with
 * one name in different folders are told apart), the alias that matched, and
 * the one row that links a page nobody has written yet.
 */

import { t } from "@lingui/core/macro";
import { FilePlus2, FileText } from "lucide-react";
import { useSyncExternalStore } from "react";

import { closedSuggestionMenu } from "@/core/completion";
import { getLinkPickerMenu, type LinkPickerItem } from "@/core/editor/extensions/link-picker";

import { type EditorChromeSurfaceProps, SuggestionMenu } from "../../chrome";

const NO_SUBSCRIPTION = () => () => {};
const closed = () => closedSuggestionMenu<LinkPickerItem>();

export function LinkPickerMenu({ editor }: EditorChromeSurfaceProps) {
  const menu = getLinkPickerMenu(editor);
  const snapshot = useSyncExternalStore(
    menu?.subscribe ?? NO_SUBSCRIPTION,
    () => menu?.snapshot() ?? closed(),
    closed,
  );
  if (!menu) return null;

  return (
    <SuggestionMenu
      editor={editor}
      typingElement={editor.view.dom}
      id="link-picker-menu"
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
        content: <LinkPickerRow item={item} />,
      }))}
    />
  );
}

function LinkPickerRow({ item }: { item: LinkPickerItem }) {
  if (item.kind === "create") {
    return (
      <>
        <FilePlus2 aria-hidden />
        <span className="truncate">{t`Create “${item.name}”`}</span>
        <span className="ml-auto shrink-0 pl-4 text-ink-subtle text-xs">
          {t`links now, page later`}
        </span>
      </>
    );
  }

  return (
    <>
      <FileText aria-hidden />
      <span className="truncate">
        {item.name}
        {item.matchedAlias ? (
          <span className="text-ink-subtle"> {t`(also ${item.matchedAlias})`}</span>
        ) : null}
      </span>
      <span className="ml-auto shrink-0 pl-4 text-ink-subtle text-xs">{item.location}</span>
    </>
  );
}
