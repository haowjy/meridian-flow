/** Standalone editor and save banner for a device-local temporary document. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { mdxCodec } from "@meridian/markup";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { type TempDocument, useTempDocsStore } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { EditorToolbar } from "@/features/editor/EditorToolbar";
import { invalidContextEntryNameReason, joinContextEntryPath } from "./context-entry-name";
import "@/features/editor/editor.css";

const DESTINATIONS: readonly ProjectContextTreeScheme[] = ["manuscript", "kb", "user"];

export function TempDocumentEditor({
  projectId,
  activeThreadId,
  document,
  onSaved,
}: {
  projectId: string;
  activeThreadId: string | null;
  document: TempDocument;
  onSaved: (scheme: ProjectContextTreeScheme, path: string) => void;
}) {
  const updateTemp = useTempDocsStore((state) => state.updateTemp);
  const removeTemp = useTempDocsStore((state) => state.removeTemp);
  const [scheme, setScheme] = useState<ProjectContextTreeScheme>("manuscript");
  const [name, setName] = useState(document.name);
  const [error, setError] = useState<string | null>(null);
  const mutation = useCreateContextEntry(projectId, scheme, { activeThreadId });
  const editor = useEditor({
    extensions: createStandaloneEditorExtensions(),
    content: document.content,
    autofocus: true,
    editorProps: {
      attributes: {
        class: "prose-tokens focus-ring min-h-full px-6 py-6 md:px-10 md:py-8",
        "aria-label": t`Temporary document editor`,
      },
    },
    onUpdate: ({ editor: updatedEditor }) =>
      updateTemp(projectId, document.id, updatedEditor.getJSON()),
  });

  useEffect(() => () => editor?.destroy(), [editor]);

  async function save() {
    const trimmed = name.trim();
    const validation = trimmed ? invalidContextEntryNameReason(trimmed) : t`Name is required`;
    if (validation) {
      setError(validation);
      return;
    }
    if (!editor) return;
    const path = joinContextEntryPath("", trimmed);
    try {
      const content = mdxCodec({ schema: editor.schema }).serialize(
        Array.from({ length: editor.state.doc.childCount }, (_, index) =>
          editor.state.doc.child(index),
        ),
      );
      await mutation.mutateAsync({ type: "file", path, content });
      removeTemp(projectId, document.id);
      onSaved(scheme, path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Couldn't save this document.`);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <section
        className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-subtle px-3 py-2"
        aria-label={t`Save temporary document`}
      >
        <p className="mr-auto text-xs text-muted-foreground">
          <Trans>Not saved to your project yet.</Trans>
        </p>
        <Select
          value={scheme}
          onValueChange={(value) => setScheme(value as ProjectContextTreeScheme)}
        >
          <SelectTrigger size="sm" aria-label={t`Destination folder`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DESTINATIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {destinationLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="h-8 w-44"
          aria-label={t`File name`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          aria-invalid={Boolean(error)}
        />
        <Button size="sm" disabled={mutation.isPending} onClick={() => void save()}>
          <Trans>Save</Trans>
        </Button>
        {error ? (
          <p className="basis-full text-right text-destructive text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      <EditorToolbar editor={editor} />
      <div data-stable-layout-scroll className="min-h-0 flex-1 overflow-auto">
        <EditorContent editor={editor} className="min-h-full" />
      </div>
    </div>
  );
}

function destinationLabel(scheme: ProjectContextTreeScheme): string {
  if (scheme === "manuscript") return t`Manuscript`;
  if (scheme === "kb") return t`Knowledge Base`;
  return t`User Files`;
}
