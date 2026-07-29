/**
 * SlashMenu — the list `/` opens (§5.7, mockup 07).
 *
 * The writer never leaves the sentence: focus stays in the prose, the query
 * they are typing IS the document text after the `/`, and this surface only
 * shows what the trigger has already matched. That is why nothing here is
 * focusable and why every row cancels its own mousedown — a menu that took
 * focus would stop the next keystroke from filtering.
 *
 * The keyboard is not here either. Arrow keys and Enter are registered against
 * the chrome kernel by the trigger, at scope `layer`, from the moment the menu
 * opens; this component follows the highlight with the scroll and renders it.
 * Esc is the kernel's chain, reached by being an open layer.
 */

import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  getSlashMenu,
  type SlashCommandId,
  type SlashMenuSnapshot,
} from "@/core/editor/extensions/slash";
import { cn } from "@/lib/utils";

import { type EditorChromeSurfaceProps, EditorPopover, useChromeSuppressed } from "../../chrome";
import { SLASH_MENU_ICONS } from "./slash-menu-icons";

const LISTBOX_ID = "meridian-slash-menu";

const optionId = (id: SlashCommandId) => `meridian-slash-option-${id}`;

const CLOSED: SlashMenuSnapshot = {
  open: false,
  items: [],
  activeIndex: 0,
  query: "",
  anchorRect: null,
  label: "",
  groupLabels: null,
};

const NO_SUBSCRIPTION = () => () => {};

/** Which edges have more list behind them, for the hairline fades. */
type Overflow = "none" | "top" | "bottom" | "both";

export function SlashMenu({ editor }: EditorChromeSurfaceProps) {
  const menu = getSlashMenu(editor);
  const snapshot = useSyncExternalStore(
    menu?.subscribe ?? NO_SUBSCRIPTION,
    () => menu?.snapshot() ?? CLOSED,
    () => CLOSED,
  );
  // Law: a surface stands down while a drag or sweep is in flight, without
  // guessing which gesture it was.
  const suppressed = useChromeSuppressed(editor);
  const open = snapshot.open && !suppressed;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState<Overflow>("none");

  const readOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const above = scroller.scrollTop > 1;
    const below = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    setOverflow(above && below ? "both" : above ? "top" : below ? "bottom" : "none");
  }, []);

  // The scroll follows the arrow keys (ruled), and `nearest` plus the
  // scroller's own scroll padding keeps the highlighted row clear of the fade.
  useEffect(() => {
    if (!open) return;
    activeRef.current?.scrollIntoView({ block: "nearest" });
    readOverflow();
  }, [open, readOverflow]);

  const activeItem = snapshot.items[snapshot.activeIndex];

  // Tells a screen reader what the caret's own element now controls. The prose
  // keeps focus, so the announcement has to travel from there.
  useEffect(() => {
    const prose = editor.isDestroyed ? null : editor.view.dom;
    if (!prose || !open) return;
    prose.setAttribute("aria-expanded", "true");
    prose.setAttribute("aria-controls", LISTBOX_ID);
    if (activeItem) prose.setAttribute("aria-activedescendant", optionId(activeItem.id));
    return () => {
      prose.removeAttribute("aria-expanded");
      prose.removeAttribute("aria-controls");
      prose.removeAttribute("aria-activedescendant");
    };
  }, [editor, open, activeItem]);

  if (!menu) return null;

  const { groupLabels } = snapshot;
  // Group headings answer "what is in this menu"; a filtered list is already
  // an answer, and the mockup's state B drops them (they would also fragment,
  // since matches sort by score rather than by group).
  const grouped = snapshot.query === "" && groupLabels !== null;

  return (
    <EditorPopover
      editor={editor}
      id="slash-menu"
      open={open}
      onOpenChange={(next) => {
        if (!next) menu.dismiss();
      }}
      anchorRect={snapshot.anchorRect}
      align="start"
      side="bottom"
      focusOnOpen="prose"
      className="meridian-slash-menu-shell min-w-56 p-0"
    >
      <div
        ref={scrollerRef}
        onScroll={readOverflow}
        id={LISTBOX_ID}
        role="listbox"
        aria-label={snapshot.label}
        data-overflow={overflow}
        className="meridian-slash-menu p-1"
      >
        {snapshot.items.map((item, index) => {
          const Icon = SLASH_MENU_ICONS[item.id];
          const active = index === snapshot.activeIndex;
          const opensGroup = grouped && item.group !== snapshot.items[index - 1]?.group;

          return (
            <Fragment key={item.id}>
              {opensGroup ? (
                <div className="px-2 pt-2 pb-1 font-semibold text-ink-subtle text-xs uppercase tracking-wider">
                  {groupLabels[item.group]}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                id={optionId(item.id)}
                aria-selected={active}
                ref={active ? activeRef : undefined}
                tabIndex={-1}
                className={cn(
                  "flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden",
                  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                  active && "bg-accent text-accent-foreground",
                )}
                // The caret is the writer's place in the chapter; a menu row
                // taking focus from it would end the filter mid-word.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => menu.setActiveIndex(index)}
                onClick={() => menu.choose(index)}
              >
                <Icon aria-hidden />
                <span>{item.label}</span>
                {item.hint ? (
                  <span className="ml-auto pl-4 text-ink-subtle text-xs">{item.hint}</span>
                ) : null}
              </button>
            </Fragment>
          );
        })}
      </div>
    </EditorPopover>
  );
}
