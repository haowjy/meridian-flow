import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { TrackedSchemaType } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Heading,
  ImageUp,
  Italic,
  Link as LinkIcon,
  List,
  type LucideIcon,
  Redo2,
  Undo2,
} from "lucide-react";
import { type ComponentProps, memo, type ReactNode, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChooserMark } from "@/components/ui/marks";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openLinkForm } from "@/core/editor/links";
import { EditorMenu, EditorMenuRadioGroup, EditorMenuRadioItem } from "@/features/editor/chrome";
import { cn } from "@/lib/utils";
import { BlockTypeMenuItem, HEADING_ICONS } from "./BlockTypeMenuItem";
import { ToolbarButton, ToolbarControlTooltip, toolbarControlClass } from "./ToolbarButton";
import {
  canRedoDocument,
  canUndoDocument,
  currentAlignmentValue,
  currentHeadingLevel,
  documentToolbarControls,
  redoDocument,
  setToolbarAlignment,
  type ToolbarAlignmentValue,
  type ToolbarControlId,
  type ToolbarControlState,
  textLevelStates,
  toggleBulletListBlock,
  toggleCodeBlockBlock,
  toggleTextMark,
  undoDocument,
} from "./toolbar-commands";
import { blockedReasonMessage, toolbarControlLabel } from "./toolbar-copy";

export type DocumentToolbarProps = {
  editor: Editor | null;
  editable?: boolean;
  schemaType?: TrackedSchemaType;
  onUploadFigure?: () => void;
  uploadAvailable?: boolean;
};

export const DocumentToolbar = memo(function DocumentToolbar({
  editor,
  editable = true,
  schemaType = "document",
  onUploadFigure,
  uploadAvailable = true,
}: DocumentToolbarProps) {
  useLingui();
  const selectToolbarState = useCallback(
    ({ editor: target }: { editor: Editor | null }) => ({
      controls: documentToolbarControls({
        editor: target,
        editable,
        schemaType,
        canUndo: canUndoDocument(target),
        canRedo: canRedoDocument(target),
        imageUploadAvailable: uploadAvailable,
      }),
      alignment:
        target && !target.isDestroyed ? currentAlignmentValue(target) : ("default" as const),
      headingLevel: target && !target.isDestroyed ? currentHeadingLevel(target) : null,
    }),
    [editable, schemaType, uploadAvailable],
  );
  const { controls, alignment, headingLevel } =
    useEditorState({
      editor,
      selector: selectToolbarState,
    }) ?? selectToolbarState({ editor });
  const run = (command: (editor: Editor) => unknown) => () => {
    if (editor && !editor.isDestroyed) command(editor);
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="flex w-auto min-w-0 items-center gap-1"
        role="toolbar"
        aria-label={t`Editor formatting toolbar`}
      >
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarControl id="undo" state={controls.undo} onPress={run(undoDocument)}>
            <Undo2 aria-hidden />
          </ToolbarControl>
          <ToolbarControl id="redo" state={controls.redo} onPress={run(redoDocument)}>
            <Redo2 aria-hidden />
          </ToolbarControl>
        </div>
        <span className="mx-0.5 h-3.5 w-px shrink-0 bg-border-subtle" aria-hidden />
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <ToolbarMenuControl
            editor={editor}
            id="heading"
            state={controls.heading}
            icon={headingLevel === null ? Heading : HEADING_ICONS[headingLevel]}
          >
            {(target) =>
              textLevelStates(target).map(({ id, state }) => (
                <BlockTypeMenuItem
                  key={id}
                  editor={target}
                  id={id}
                  active={state.active}
                  blockedReason={blockedReasonMessage("block-type", state.blockedBy)}
                />
              ))
            }
          </ToolbarMenuControl>
          <ToolbarControl
            id="bold"
            state={controls.bold}
            onPress={run((target) => toggleTextMark(target, "strong"))}
          >
            <Bold aria-hidden />
          </ToolbarControl>
          <ToolbarControl
            id="italic"
            state={controls.italic}
            onPress={run((target) => toggleTextMark(target, "em"))}
          >
            <Italic aria-hidden />
          </ToolbarControl>
          <ToolbarControl
            id="codeBlock"
            state={controls.codeBlock}
            onPress={run(toggleCodeBlockBlock)}
          >
            <Code aria-hidden />
          </ToolbarControl>
          <ToolbarControl
            id="bulletList"
            state={controls.bulletList}
            onPress={run(toggleBulletListBlock)}
          >
            <List aria-hidden />
          </ToolbarControl>
          <ToolbarControl id="link" state={controls.link} onPress={() => openLinkForm(editor)}>
            <LinkIcon aria-hidden />
          </ToolbarControl>
          <ToolbarMenuControl
            editor={editor}
            id="alignment"
            state={controls.alignment}
            icon={ALIGNMENT_ICONS[alignment]}
          >
            {(target) => (
              <EditorMenuRadioGroup
                value={alignment}
                onValueChange={(next) => setToolbarAlignment(target, next as ToolbarAlignmentValue)}
              >
                <EditorMenuRadioItem value="default">
                  <AlignLeft aria-hidden />
                  {t`Default alignment`}
                </EditorMenuRadioItem>
                <EditorMenuRadioItem value="center">
                  <AlignCenter aria-hidden />
                  {t`Center`}
                </EditorMenuRadioItem>
                <EditorMenuRadioItem value="right">
                  <AlignRight aria-hidden />
                  {t`Right`}
                </EditorMenuRadioItem>
              </EditorMenuRadioGroup>
            )}
          </ToolbarMenuControl>
          <ToolbarControl
            id="uploadFigure"
            state={controls.uploadFigure}
            onPress={() => onUploadFigure?.()}
          >
            <ImageUp aria-hidden />
          </ToolbarControl>
        </div>
      </div>
    </TooltipProvider>
  );
});

function ToolbarControl({
  id,
  state,
  onPress,
  children,
}: {
  id: ToolbarControlId;
  state: ToolbarControlState;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <ToolbarButton
      label={toolbarControlLabel(id)}
      blockedReason={blockedReasonMessage(id, state.blockedBy)}
      active={state.active}
      onPress={onPress}
    >
      {children}
    </ToolbarButton>
  );
}

const ALIGNMENT_ICONS = {
  default: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
} as const;

function ToolbarMenuControl({
  editor,
  id,
  state,
  icon,
  children,
}: {
  editor: Editor | null;
  id: ToolbarControlId;
  state: ToolbarControlState;
  icon: LucideIcon;
  children: (editor: Editor) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = toolbarControlLabel(id);
  const blockedReason = blockedReasonMessage(id, editor ? state.blockedBy : "editor-loading");

  if (!editor || blockedReason) {
    return (
      <MenuTrigger label={label} blockedReason={blockedReason} active={state.active} icon={icon} />
    );
  }

  return (
    <EditorMenu
      editor={editor}
      id={`toolbar-${id}`}
      open={open}
      onOpenChange={setOpen}
      align="start"
      trigger={<MenuTrigger label={label} active={state.active} icon={icon} />}
    >
      {children(editor)}
    </EditorMenu>
  );
}

/**
 * A menu control's button, live or greyed.
 *
 * The rest props are the menu's. `EditorMenu` hands its trigger to Radix as a
 * slot, so the press, the ARIA state, and the anchor's ref arrive here and go
 * on through the tooltip to the button — a trigger that swallowed them would
 * be a control that cannot be opened.
 */
function MenuTrigger({
  label,
  blockedReason,
  active,
  icon: Icon,
  ...rest
}: ComponentProps<"button"> & {
  label: string;
  blockedReason?: string | null;
  active: boolean;
  icon: LucideIcon;
}) {
  const blocked = Boolean(blockedReason);

  return (
    <ToolbarControlTooltip label={label} blockedReason={blockedReason}>
      <Button
        {...rest}
        type="button"
        variant="ghost"
        size="xs"
        aria-label={label}
        aria-pressed={active || undefined}
        aria-disabled={blocked || undefined}
        className={cn(
          "gap-px px-1 has-[>svg]:px-1 coarse:min-w-11",
          toolbarControlClass({ active, blocked }),
        )}
      >
        <Icon aria-hidden />
        <ChooserMark />
      </Button>
    </ToolbarControlTooltip>
  );
}
