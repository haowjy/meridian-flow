/**
 * ReadOnlyDocHost — shared read-only host for resolved context document tabs.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";

import type { ContextTab } from "@/client/stores";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

import { ContextViewerBareHost } from "./ContextViewerHost";

const EditorView = lazy(() =>
  import("@/features/editor/EditorView").then((m) => ({ default: m.EditorView })),
);

export type ReadOnlyDocHostProps = {
  projectId: string;
  activeThreadId: string | null;
  tab: ContextTab;
  /** Registry owner key — callers pass their own so retention is scoped. */
  registryOwner: string;
};

export function ReadOnlyDocHost({
  projectId,
  activeThreadId,
  tab,
  registryOwner,
}: ReadOnlyDocHostProps) {
  useEffect(() => {
    if (tab.editable) {
      getDocumentSessionRegistry().retain(registryOwner, [tab.documentId]);
      return () => getDocumentSessionRegistry().retain(registryOwner, []);
    }
    getDocumentSessionRegistry().retain(registryOwner, []);
    return undefined;
  }, [registryOwner, tab.documentId, tab.editable]);

  useEffect(() => {
    return () => getDocumentSessionRegistry().release(registryOwner);
  }, [registryOwner]);

  if (!tab.editable) {
    return (
      <ContextViewerBareHost projectId={projectId} activeThreadId={activeThreadId} tab={tab} />
    );
  }

  return (
    <div className="h-full min-h-0">
      <Suspense
        fallback={
          <ReadOnlyDocStatus>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <Trans>Opening document…</Trans>
          </ReadOnlyDocStatus>
        }
      >
        <EditorView
          projectId={projectId}
          documentId={tab.documentId}
          schemaType={tab.schemaType}
          editable={false}
          showToolbar={false}
          ariaLabel={t`Read-only live document`}
          showCollaborationDecorations={false}
        />
      </Suspense>
    </div>
  );
}

function ReadOnlyDocStatus({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
