/** Writer-facing schema-fence banner and isolated read-only document preview. */
import { Trans } from "@lingui/react/macro";
import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { EditorOptions } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import type {
  DocumentSession,
  DocumentSessionSnapshot,
  SchemaFence,
} from "@/core/editor/document-session";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";
import { cloneDocumentForSchemaFencePreview } from "@/core/editor/schema-fence";
import { cn } from "@/lib/utils";
import { EditorSurfaceFrame } from "./EditorSurfaceFrame";
import { editorColumnCanvas, editorColumnFill, editorProseClass } from "./editor-column";

export function useSchemaFence(session: DocumentSession): SchemaFence | null {
  const [snapshot, setSnapshot] = useState<DocumentSessionSnapshot>(() => session.getSnapshot());

  useEffect(() => session.subscribe(setSnapshot), [session]);

  return snapshot.schemaFence;
}

export function SchemaFenceBanner({ fence }: { fence: SchemaFence }) {
  return (
    <section
      className="surface-card flex min-w-0 shrink-0 items-center gap-3 border-destructive-border border-b px-4 py-2"
      data-schema-fence-banner
      role="alert"
      aria-live="assertive"
    >
      <p className="min-w-0 flex-1 text-foreground text-sm">{schemaFenceCopy(fence.reason)}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={() => window.location.reload()}
      >
        <Trans>Refresh</Trans>
      </Button>
    </section>
  );
}

function schemaFenceCopy(reason: SchemaFence["reason"]) {
  switch (reason) {
    case "client-superseded":
      return (
        <Trans>
          This chapter was opened in a newer version of Meridian. Refresh to keep writing.
        </Trans>
      );
    case "invalid-content":
      return (
        <Trans>
          Part of this chapter can't be opened safely in this version of Meridian. Editing is paused
          to protect your manuscript. Refresh to try again.
        </Trans>
      );
    case "repair-detected":
      return (
        <Trans>
          Part of this chapter couldn't be kept in this version of Meridian. Editing is paused to
          protect your manuscript. Refresh to continue.
        </Trans>
      );
  }
}

export function createSchemaFencePreviewConfig({
  document,
  schemaType,
  projectId,
  documentId,
  ariaLabel,
}: {
  document: DocumentSession["document"];
  schemaType: YjsTrackedSchemaType;
  projectId?: string;
  documentId: string;
  ariaLabel?: string;
}): Partial<EditorOptions> {
  return {
    extensions: [
      ...createStandaloneEditorExtensions({
        schemaType,
        figureRenderContext: { projectId, documentId },
      }),
      Collaboration.configure({
        document,
        fragment: document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
      }),
    ],
    editable: false,
    autofocus: false,
    editorProps: {
      attributes: {
        class: editorProseClass("none"),
        "aria-label": ariaLabel ?? "Read-only chapter preview",
      },
    },
  };
}

export function SchemaFencePreview({
  session,
  schemaType,
  projectId,
  documentId,
  ariaLabel,
}: {
  session: DocumentSession;
  schemaType: YjsTrackedSchemaType;
  projectId?: string;
  documentId: string;
  ariaLabel?: string;
}) {
  const previewDocument = useMemo(
    () => cloneDocumentForSchemaFencePreview(session.document),
    [session],
  );
  const editor = useEditor(
    {
      ...createSchemaFencePreviewConfig({
        document: previewDocument,
        schemaType,
        projectId,
        documentId,
        ariaLabel,
      }),
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
    },
    [previewDocument, schemaType, projectId, documentId, ariaLabel],
  );

  useEffect(() => () => previewDocument.destroy(), [previewDocument]);

  return (
    <EditorSurfaceFrame scrollClassName="meridian-editor main-pane relative">
      <div className={cn(editorColumnCanvas, editorColumnFill)} data-schema-fence-preview>
        <EditorContent editor={editor} className={editorColumnFill} />
      </div>
    </EditorSurfaceFrame>
  );
}
