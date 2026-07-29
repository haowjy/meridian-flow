/**
 * WikilinkMenu — the documents `[[` offers (§5.5, mockup 06 state D).
 *
 * Rows and nothing else: the physics are `SuggestionMenu`'s, shared with the
 * slash menu, so a writer meets both the same way. What this file decides is
 * what a row says — the document's name, where it lives, the alias that
 * matched, and the one row that links a page nobody has written yet.
 */

import { t } from "@lingui/core/macro";
import { FilePlus2, FileText } from "lucide-react";
import { useSyncExternalStore } from "react";

import { closedSuggestionMenu } from "@/core/editor/extensions/suggestion";
import { getWikilinkMenu, type WikilinkMenuItem } from "@/core/editor/extensions/wikilink";

import { type EditorChromeSurfaceProps, SuggestionMenu } from "../../chrome";

const NO_SUBSCRIPTION = () => () => {};
const closed = () => closedSuggestionMenu<WikilinkMenuItem>();

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
        content: <WikilinkRow item={item} />,
      }))}
    />
  );
}

function WikilinkRow({ item }: { item: WikilinkMenuItem }) {
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
      <span className="ml-auto shrink-0 pl-4 text-ink-subtle text-xs">
        {/* Two documents answering to one name resolve to neither, so telling
            them apart by folder would not help: what the writer needs to know
            is that this link will not land until one of them is renamed. */}
        {item.ambiguous ? t`two documents share this name` : item.location}
      </span>
    </>
  );
}
