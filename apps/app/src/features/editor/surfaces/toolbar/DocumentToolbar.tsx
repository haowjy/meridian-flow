/**
 * DocumentToolbar — the editor's one persistent chrome row.
 *
 * It carries the document-level verbs and never contextual ones: the geometry
 * is fixed, so controls never move, vanish, or gain neighbors as the caret
 * travels. Contextual verbs belong to the surfaces anchored to the
 * block that owns them. `EditorSurfaceFrame` docks this row above the scroll
 * area, prose-aligned; the row itself is bare, with no card chrome.
 *
 * Everything a control knows about its own state comes from
 * `toolbar-commands.ts`: lit when applied, greyed with a reason when it cannot
 * apply. This file renders that matrix and dispatches; it decides nothing.
 */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
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
  /** False behind a schema fence or a read-only host: every verb greys. */
  editable?: boolean;
  /** A code file takes no figures; the control greys rather than lying. */
  schemaType?: YjsTrackedSchemaType;
  onUploadFigure?: () => void;
  /** Uploads need a project to own the asset; without one the control greys. */
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
  // Compare the matrix, not transaction revisions: review metadata and focus
  // transactions must not rebuild the row. Alignment's value and the heading
  // level matter even when their active flag stays true (center to right).
  const { controls, alignment, headingLevel } =
    useEditorState({
      editor,
      selector: selectToolbarState,
    }) ?? selectToolbarState({ editor });
  const run = (command: (editor: Editor) => unknown) => () => {
    if (editor && !editor.isDestroyed) command(editor);
  };

  return (
    // The row carries its own tooltip provider so the module renders anywhere,
    // and with a delay: a pointer crossing ten dense controls should not set
    // off ten tooltips, but resting on one must answer.
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
        {/* History is the writer's recovery, not a formatting verb; the rule
          keeps it legible as its own group without adding a second row. */}
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
          {/* The link form is not the toolbar's surface: it belongs to the
            link lane and opens over the writer's own words, wherever they are.
            The button is one more door into it, beside Ctrl+K and Add link. */}
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

/** A control that opens a menu of values, each a verb on the selection. */
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
  /** What the button wears: the value the selection already has. */
  icon: LucideIcon;
  children: (editor: Editor) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = toolbarControlLabel(id);
  // Without an editor the matrix already says "still opening"; naming it here
  // is what lets the rest of this component assume one.
  const blockedReason = blockedReasonMessage(id, editor ? state.blockedBy : "editor-loading");

  // A greyed control opens nothing, so no menu is composed around it at all;
  // the button keeps its geometry and explains itself instead.
  if (!editor || blockedReason) {
    return (
      <MenuTrigger label={label} blockedReason={blockedReason} active={state.active} icon={icon} />
    );
  }

  return (
    // Through `EditorMenu` like every other menu in the editor: the kernel sees
    // the open layer, so Escape spends one step on it and the caret goes back
    // to the prose rather than to this button.
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
        // Wider than the icon buttons by exactly the chevron it carries: the
        // dropdown says so before it is opened.
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
