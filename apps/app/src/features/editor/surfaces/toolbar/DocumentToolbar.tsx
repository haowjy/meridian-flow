/**
 * DocumentToolbar — the editor's one persistent chrome row.
 *
 * It carries the document-level verbs and never contextual ones: the geometry
 * is fixed, so controls never move, vanish, or gain neighbors as the caret
 * travels (ruling 15). Contextual verbs belong to the surfaces anchored to the
 * block that owns them. `EditorSurfaceFrame` docks this row above the scroll
 * area, prose-aligned; the row itself is bare, with no card chrome.
 *
 * Everything a control knows about its own state comes from
 * `toolbar-commands.ts`: lit when applied, greyed with a reason when it cannot
 * apply. This file renders that matrix and dispatches; it decides nothing.
 */
import { t } from "@lingui/core/macro";
import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Code,
  Heading1,
  ImageUp,
  Italic,
  List,
  Redo2,
  Undo2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LinkControl } from "./LinkPopover";
import { ToolbarButton, ToolbarControlTooltip, toolbarControlClass } from "./ToolbarButton";
import {
  canRedoDocument,
  canUndoDocument,
  currentAlignmentValue,
  documentToolbarControls,
  redoDocument,
  setToolbarAlignment,
  type ToolbarAlignmentValue,
  type ToolbarControlId,
  type ToolbarControlState,
  toggleBulletListBlock,
  toggleCodeBlockBlock,
  toggleHeadingBlock,
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
  uploadBusy?: boolean;
  /** Uploads need a project to own the asset; without one the control greys. */
  uploadAvailable?: boolean;
};

export function DocumentToolbar({
  editor,
  editable = true,
  schemaType = "document",
  onUploadFigure,
  uploadBusy = false,
  uploadAvailable = true,
}: DocumentToolbarProps) {
  useEditorRevision(editor);

  const controls = documentToolbarControls({
    editor,
    editable,
    schemaType,
    canUndo: canUndoDocument(editor),
    canRedo: canRedoDocument(editor),
    imageUploadAvailable: uploadAvailable,
    imageUploadBusy: uploadBusy,
  });
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
            <Undo2 className="size-3.5" aria-hidden />
          </ToolbarControl>
          <ToolbarControl id="redo" state={controls.redo} onPress={run(redoDocument)}>
            <Redo2 className="size-3.5" aria-hidden />
          </ToolbarControl>
        </div>
        {/* History is the writer's recovery, not a formatting verb; the rule
          keeps it legible as its own group without adding a second row. */}
        <span className="mx-0.5 h-3.5 w-px shrink-0 bg-border-subtle" aria-hidden />
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <ToolbarControl id="heading" state={controls.heading} onPress={run(toggleHeadingBlock)}>
            <Heading1 className="size-3.5" aria-hidden />
          </ToolbarControl>
          <ToolbarControl
            id="bold"
            state={controls.bold}
            onPress={run((target) => toggleTextMark(target, "strong"))}
          >
            <Bold className="size-3.5" aria-hidden />
          </ToolbarControl>
          <ToolbarControl
            id="italic"
            state={controls.italic}
            onPress={run((target) => toggleTextMark(target, "em"))}
          >
            <Italic className="size-3.5" aria-hidden />
          </ToolbarControl>
          <ToolbarControl
            id="codeBlock"
            state={controls.codeBlock}
            onPress={run(toggleCodeBlockBlock)}
          >
            <Code className="size-3.5" aria-hidden />
          </ToolbarControl>
          <ToolbarControl
            id="bulletList"
            state={controls.bulletList}
            onPress={run(toggleBulletListBlock)}
          >
            <List className="size-3.5" aria-hidden />
          </ToolbarControl>
          <LinkControl editor={editor} state={controls.link} />
          <AlignmentControl editor={editor} state={controls.alignment} />
          <ToolbarControl
            id="uploadFigure"
            state={controls.uploadFigure}
            onPress={() => onUploadFigure?.()}
          >
            <ImageUp className="size-3.5" aria-hidden />
          </ToolbarControl>
        </div>
      </div>
    </TooltipProvider>
  );
}

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

function AlignmentControl({
  editor,
  state,
}: {
  editor: Editor | null;
  state: ToolbarControlState;
}) {
  const label = toolbarControlLabel("alignment");
  // Without an editor the matrix already says "still opening"; naming it here
  // is what lets the rest of this component assume one.
  const blockedReason = blockedReasonMessage(
    "alignment",
    editor ? state.blockedBy : "editor-loading",
  );
  const value: ToolbarAlignmentValue = editor ? currentAlignmentValue(editor) : "default";
  const Icon = ALIGNMENT_ICONS[value];

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={label}
      aria-pressed={state.active || undefined}
      aria-disabled={blockedReason ? true : undefined}
      // Wider than the icon buttons by exactly the chevron it carries: the
      // dropdown says so before it is opened.
      className={cn(
        "gap-px px-1 has-[>svg]:px-1",
        toolbarControlClass({ active: state.active, blocked: Boolean(blockedReason) }),
      )}
      onClick={blockedReason ? (event) => event.preventDefault() : undefined}
    >
      <Icon className="size-3.5" aria-hidden />
      <ChevronDown className="size-2.5" aria-hidden />
    </Button>
  );

  // A greyed control opens nothing, so the menu trigger is not composed around
  // it at all; the button keeps its geometry and explains itself instead.
  if (!editor || blockedReason) {
    return (
      <ToolbarControlTooltip label={label} blockedReason={blockedReason}>
        {trigger}
      </ToolbarControlTooltip>
    );
  }

  return (
    <DropdownMenu>
      <ToolbarControlTooltip label={label}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      </ToolbarControlTooltip>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => {
          // Radix hands focus back to the trigger on both close paths, where
          // the writer's next Space reopens the menu instead of typing. The
          // caret never left the prose; the focus goes with it.
          event.preventDefault();
          if (!editor.isDestroyed) editor.commands.focus();
        }}
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => setToolbarAlignment(editor, next as ToolbarAlignmentValue)}
        >
          <DropdownMenuRadioItem value="default">
            <AlignLeft aria-hidden />
            {t`Default alignment`}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="center">
            <AlignCenter aria-hidden />
            {t`Center`}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="right">
            <AlignRight aria-hidden />
            {t`Right`}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The toolbar reads the editor on every render, so it re-renders on anything
 * that can move the selection or the document. TipTap emits both events for a
 * transaction; the state bump is deliberately coarse because the whole matrix
 * is derived, not stored.
 */
function useEditorRevision(editor: Editor | null) {
  const [, setRevision] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const bump = () => setRevision((revision) => revision + 1);
    editor.on("selectionUpdate", bump);
    editor.on("transaction", bump);
    return () => {
      editor.off("selectionUpdate", bump);
      editor.off("transaction", bump);
    };
  }, [editor]);
}
