/**
 * TempDocumentEditor — a device-local document on the shared writing surface.
 *
 * Thin composition: a standalone TipTap editor on the same prose column and
 * frame as tracked documents (a temp doc is the same writing surface as the
 * tracked doc it becomes on save), the `TempDocumentSaveBar` above it, and the
 * `useTempDocumentSave` flow wiring the two together.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { mdxCodec } from "@meridian/markup";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";
import { type TempDocument, useTempDocsStore } from "@/client/stores";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { EditorSurfaceFrame } from "@/features/editor/EditorSurfaceFrame";
import { EditorToolbar } from "@/features/editor/EditorToolbar";
import {
  editorColumnCanvas,
  editorColumnFill,
  editorProseClass,
} from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import { TempDocumentSaveBar } from "./TempDocumentSaveBar";
import { useTempDocumentSave } from "./use-temp-document-save";
import "@/features/editor/editor.css";

export function TempDocumentEditor({
  projectId,
  activeThreadId,
  document,
  onOpenSaved,
  onVerificationFailed,
}: {
  projectId: string;
  activeThreadId: string | null;
  document: TempDocument;
  onOpenSaved: (scheme: ProjectContextTreeScheme, path: string) => void;
  onVerificationFailed: () => void;
}) {
  const updateTemp = useTempDocsStore((state) => state.updateTemp);
  const editor = useEditor({
    extensions: createStandaloneEditorExtensions(),
    content: document.content,
    autofocus: true,
    editorProps: {
      attributes: {
        // No focus-ring: the caret is the canvas's focus indicator — a
        // control-style ring around the whole page reads as an error box
        // (and always fires here, since autofocus counts as keyboard focus).
        class: editorProseClass("docked"),
        "aria-label": t`Temporary document editor`,
      },
    },
    onUpdate: ({ editor: updatedEditor }) => {
      const content = updatedEditor.getJSON();
      updateTemp(projectId, document.id, content);
      save.noteContent(content);
    },
  });
  const save = useTempDocumentSave({
    projectId,
    activeThreadId,
    document,
    captureContent: () =>
      editor
        ? mdxCodec({ schema: editor.schema }).serialize(
            Array.from({ length: editor.state.doc.childCount }, (_, index) =>
              editor.state.doc.child(index),
            ),
          )
        : null,
    onOpenSaved,
    onVerificationFailed,
  });

  useEffect(() => () => editor?.destroy(), [editor]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <TempDocumentSaveBar
        projectId={projectId}
        activeThreadId={activeThreadId}
        save={save}
        onOpenExisting={onOpenSaved}
      />
      <EditorSurfaceFrame
        toolbar={<EditorToolbar editor={editor} />}
        // meridian-editor gives the temp surface the same prose contract as
        // tracked documents (outline suppression, 68ch measure, block styles).
        scrollClassName="meridian-editor"
      >
        <div className={cn(editorColumnCanvas, editorColumnFill)}>
          <EditorContent editor={editor} className={editorColumnFill} />
        </div>
      </EditorSurfaceFrame>
    </div>
  );
}
