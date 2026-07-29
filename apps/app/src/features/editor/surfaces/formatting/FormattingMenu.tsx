/**
 * FormattingMenu — the menu a writer asks for over a selection (§5.1).
 *
 * Selection alone raises nothing (law 7, ruling 13): highlighting is how a
 * writer reads and how they point a passage out to the AI, so formatting is
 * asked for by right-click, Menu key, or long press. `useFormattingMenuDoors`
 * owns those three; this file owns what the menu says and what each item does.
 *
 * Every item works or greys with a reason, and never disappears (law 5). The
 * marks row reflects and reverses (law 6), Turn into checks the type the block
 * already is and converts back to a paragraph when it is chosen again, and the
 * clipboard staples are here so taking the browser's menu costs the writer
 * nothing they used daily.
 */

import type { Editor } from "@tiptap/core";
import {
  Bold,
  ChevronRight,
  ClipboardPaste,
  Code,
  Copy,
  Italic,
  Link as LinkIcon,
  Repeat,
  Scissors,
  Strikethrough,
} from "lucide-react";
import { type ComponentType, type ReactNode, useRef, useState } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  EditorMenu,
  EditorMenuCheckboxItem,
  EditorMenuItem,
  EditorMenuSeparator,
  EditorMenuShortcut,
  EditorMenuSub,
  EditorMenuSubContent,
  EditorMenuSubTrigger,
  EditorPopover,
} from "../../chrome";
import {
  BLOCK_TYPE_IDS,
  type BlockedSubject,
  type BlockTypeId,
  LinkForm,
  toggleTextMark,
  turnIntoBlockType,
  useLinkDraft,
} from "../toolbar";
import {
  type ClipboardReadAvailability,
  clipboardReadAvailability,
  copySelection,
  cutSelection,
  pasteIntoSelection,
} from "./clipboard-commands";
import {
  addLinkLabel,
  blockTypeLabel,
  clipboardLabel,
  clipboardShortcut,
  formattingBlockedMessage,
  formattingMarkLabel,
  turnIntoLabel,
} from "./formatting-copy";
import {
  FORMATTING_CLIPBOARD_IDS,
  FORMATTING_MARK_IDS,
  FORMATTING_MARKS,
  type FormattingClipboardId,
  type FormattingItemState,
  type FormattingMarkId,
  type FormattingMenuModel,
  formattingMenuModel,
} from "./formatting-menu-items";
import type { FormattingMenuPoint } from "./formatting-triggers";
import { useFormattingMenuDoors } from "./useFormattingMenuDoors";

const MARK_ICONS: Record<FormattingMarkId, ComponentType<{ className?: string }>> = {
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  code: Code,
};

const CLIPBOARD_ICONS: Record<FormattingClipboardId, ComponentType<{ className?: string }>> = {
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
};

export function FormattingMenu({ editor }: { editor: Editor }) {
  const [anchor, setAnchor] = useState<FormattingMenuPoint | null>(null);
  const [linkAnchor, setLinkAnchor] = useState<FormattingMenuPoint | null>(null);
  // A browser that refused one read will refuse the next, so Paste greys with
  // the shortcut from then on rather than failing again silently (law 5).
  const [clipboardRead, setClipboardRead] =
    useState<ClipboardReadAvailability>(clipboardReadAvailability);

  useFormattingMenuDoors(editor, { isOpen: () => anchor !== null, open: setAnchor });

  const { draft: linkDraft, readDraft: readLinkDraft } = useLinkDraft(editor, linkAnchor !== null);

  // Held through the close so the menu fades out with its contents rather than
  // emptying a frame before it goes.
  const lastModel = useRef<FormattingMenuModel | null>(null);
  if (anchor) lastModel.current = formattingMenuModel(editor, { clipboardRead });
  const model = lastModel.current;

  const runPaste = () => {
    void pasteIntoSelection(editor).then((result) => {
      if (result === "denied" || result === "unavailable") setClipboardRead("unavailable");
    });
  };

  const clipboardCommands: Record<FormattingClipboardId, () => void> = {
    cut: () => void cutSelection(editor),
    copy: () => void copySelection(editor),
    paste: runPaste,
  };

  return (
    <>
      <EditorMenu
        editor={editor}
        id="formatting-menu"
        open={anchor !== null}
        onOpenChange={(open) => {
          if (!open) setAnchor(null);
        }}
        at={anchor}
      >
        {model ? (
          // Delayed, like the toolbar's: a pointer crossing four dense icons
          // should not set off four tooltips, but resting on one must answer.
          <TooltipProvider delayDuration={400}>
            <div className="flex items-center gap-0.5 px-1 py-0.5">
              {FORMATTING_MARK_IDS.map((id) => (
                <MarkButton key={id} id={id} state={model.marks[id]} editor={editor} />
              ))}
            </div>
            <EditorMenuSeparator />
            <TurnInto model={model} editor={editor} />
            <FormattingItem
              subject="link"
              label={addLinkLabel()}
              icon={LinkIcon}
              state={model.link}
              onSelect={() => setLinkAnchor(anchor)}
            />
            <EditorMenuSeparator />
            {FORMATTING_CLIPBOARD_IDS.map((id) => (
              <FormattingItem
                key={id}
                subject="document"
                label={clipboardLabel(id)}
                shortcut={clipboardShortcut(id)}
                icon={CLIPBOARD_ICONS[id]}
                state={model.clipboard[id]}
                onSelect={clipboardCommands[id]}
              />
            ))}
          </TooltipProvider>
        ) : null}
      </EditorMenu>

      {/* The link form the toolbar's control opens, summoned by a place
          instead of a button. One flow, so a link made here and a link made
          there commit the same way. */}
      <EditorPopover
        editor={editor}
        id="formatting-link"
        open={linkAnchor !== null}
        onOpenChange={(open) => {
          if (!open) setLinkAnchor(null);
        }}
        at={linkAnchor}
        className="w-80 p-2"
      >
        {linkDraft ? (
          <LinkForm
            editor={editor}
            draft={linkDraft}
            readDraft={() => readLinkDraft() ?? linkDraft}
            onClose={() => setLinkAnchor(null)}
          />
        ) : null}
      </EditorPopover>
    </>
  );
}

function MarkButton({
  id,
  state,
  editor,
}: {
  id: FormattingMarkId;
  state: FormattingItemState;
  editor: Editor;
}) {
  const label = formattingMarkLabel(id);
  const reason = formattingBlockedMessage("mark", state.blockedBy);
  const Icon = MARK_ICONS[id];

  return (
    <ReasonTooltip label={label} reason={reason}>
      <EditorMenuItem
        aria-label={label}
        aria-pressed={state.active || undefined}
        aria-disabled={reason ? true : undefined}
        className={cn(
          "size-8 justify-center rounded-sm p-0",
          state.active && "bg-primary/10",
          reason && "opacity-50",
        )}
        onSelect={(event) => {
          if (reason) {
            event.preventDefault();
            return;
          }
          toggleTextMark(editor, FORMATTING_MARKS[id]);
        }}
      >
        {/* An explicit text colour every time: the menu's own rule mutes any
            icon that has none, which would swallow the lit state. */}
        <Icon className={cn("size-4", state.active ? "text-primary" : "text-foreground")} />
      </EditorMenuItem>
    </ReasonTooltip>
  );
}

function TurnInto({ model, editor }: { model: FormattingMenuModel; editor: Editor }) {
  const label = turnIntoLabel();
  const blockedReason = formattingBlockedMessage("block-type", model.turnIntoBlockedBy);

  // Every type refuses for one reason, so the list is not worth opening: the
  // trigger greys and carries the reason itself. Radix's `disabled` would take
  // it out of the hover and focus path and the reason with it (law 5).
  if (blockedReason) {
    return (
      <ReasonTooltip reason={blockedReason}>
        <EditorMenuItem
          aria-disabled
          className="opacity-50"
          onSelect={(event) => event.preventDefault()}
        >
          <Repeat aria-hidden />
          {label}
          <ChevronRight className="ml-auto" aria-hidden />
        </EditorMenuItem>
      </ReasonTooltip>
    );
  }

  return (
    <EditorMenuSub>
      <EditorMenuSubTrigger>
        <Repeat aria-hidden />
        {label}
      </EditorMenuSubTrigger>
      <EditorMenuSubContent className="min-w-44">
        {BLOCK_TYPE_IDS.map((id) => (
          <TurnIntoItem key={id} id={id} state={model.turnInto[id]} editor={editor} />
        ))}
      </EditorMenuSubContent>
    </EditorMenuSub>
  );
}

function TurnIntoItem({
  id,
  state,
  editor,
}: {
  id: BlockTypeId;
  state: FormattingItemState;
  editor: Editor;
}) {
  const reason = formattingBlockedMessage("block-type", state.blockedBy);

  return (
    <ReasonTooltip reason={reason}>
      <EditorMenuCheckboxItem
        checked={state.active}
        aria-disabled={reason ? true : undefined}
        className={cn(reason && "opacity-50")}
        onSelect={(event) => {
          if (reason) {
            event.preventDefault();
            return;
          }
          turnIntoBlockType(editor, id);
        }}
      >
        {blockTypeLabel(id)}
      </EditorMenuCheckboxItem>
    </ReasonTooltip>
  );
}

function FormattingItem({
  subject,
  label,
  shortcut,
  icon: Icon,
  state,
  onSelect,
}: {
  subject: BlockedSubject;
  label: string;
  shortcut?: string;
  icon: ComponentType<{ className?: string }>;
  state: FormattingItemState;
  onSelect: () => void;
}) {
  const reason = formattingBlockedMessage(subject, state.blockedBy);

  return (
    <ReasonTooltip reason={reason}>
      <EditorMenuItem
        aria-disabled={reason ? true : undefined}
        className={cn(reason && "opacity-50")}
        onSelect={(event) => {
          if (reason) {
            event.preventDefault();
            return;
          }
          onSelect();
        }}
      >
        <Icon />
        {label}
        {shortcut ? <EditorMenuShortcut>{shortcut}</EditorMenuShortcut> : null}
      </EditorMenuItem>
    </ReasonTooltip>
  );
}

/**
 * The reason a greyed item carries. Labelled items say what they are already;
 * the icon-only marks row needs its label here too, which is why both are
 * optional and either one earns a tooltip.
 */
function ReasonTooltip({
  label,
  reason,
  children,
}: {
  label?: string;
  reason: string | null;
  children: ReactNode;
}) {
  if (!label && !reason) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-56">
        {label ? <span className="block">{label}</span> : null}
        {reason ? <span className="block text-background/70">{reason}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
