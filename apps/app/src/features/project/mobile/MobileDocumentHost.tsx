/**
 * MobileDocumentHost — read-only phone document/viewer host with registry retention.
 *
 * Mobile never lets users type into collaborative documents, but it keeps the
 * TipTap/Yjs binding alive so AI edits stream into the read-only editor. This
 * host is the mobile registry owner: entering a document retains exactly that
 * document; leaving the view releases it so sessions do not leak. Mobile route
 * navigation deliberately derives the active tab from the context tree instead
 * of writing to the desktop tab strip's shared open-tab set.
 *
 * Renders no filename chrome of its own — the top bar's breadcrumb names the
 * document, so content starts immediately under the top bar.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { EditorView } from "@/features/editor/EditorView";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { findContextFile } from "../context/context-tree";

const MOBILE_DOCUMENT_OWNER = "mobile-project-document-host";

export type MobileDocumentHostProps = {
  projectId: string;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
};

export function MobileDocumentHost({
  projectId,
  activeContextScheme,
  activeContextPath,
}: MobileDocumentHostProps) {
  const hasRouteDocument = activeContextScheme !== null && activeContextPath !== null;
  const { tree, isError, isFetching } = useProjectContextTree(
    projectId,
    activeContextScheme ?? "kb",
    { enabled: hasRouteDocument },
  );

  const activeTab = useMemo(() => {
    if (!hasRouteDocument || activeContextScheme === null || activeContextPath === null || !tree) {
      return null;
    }
    const file = findContextFile(tree, activeContextPath);
    return file ? contextTabFromFile(activeContextScheme, file) : null;
  }, [activeContextPath, activeContextScheme, hasRouteDocument, tree]);

  useEffect(() => {
    if (activeTab?.editable) {
      getDocumentSessionRegistry().retain(MOBILE_DOCUMENT_OWNER, [activeTab.documentId]);
      return () => getDocumentSessionRegistry().retain(MOBILE_DOCUMENT_OWNER, []);
    }
    getDocumentSessionRegistry().retain(MOBILE_DOCUMENT_OWNER, []);
    return undefined;
  }, [activeTab]);

  useEffect(() => {
    return () => getDocumentSessionRegistry().release(MOBILE_DOCUMENT_OWNER);
  }, []);

  if (!activeContextScheme || !activeContextPath) {
    return (
      <DocumentStatus tone="muted">
        <Trans>Select a document.</Trans>
      </DocumentStatus>
    );
  }

  if (!activeTab) {
    if (isFetching && !tree) {
      return (
        <DocumentStatus tone="muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <Trans>Opening document…</Trans>
        </DocumentStatus>
      );
    }
    if (isError || tree) {
      return (
        <DocumentStatus tone="error">
          <AlertCircle className="size-4" aria-hidden />
          <Trans>Couldn't open this document.</Trans>
        </DocumentStatus>
      );
    }
    return null;
  }

  if (!activeTab.editable) {
    return <ContextViewerBareHost projectId={projectId} tab={activeTab} />;
  }

  return (
    <div className="h-full min-h-0">
      <EditorView
        projectId={projectId}
        documentId={activeTab.documentId}
        schemaType={activeTab.schemaType}
        editable={false}
        showToolbar={false}
        ariaLabel={t`Read-only live document`}
        showCollaborationDecorations={false}
      />
    </div>
  );
}

function DocumentStatus({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={
        tone === "error"
          ? "grid h-full place-items-center px-6 text-center text-sm text-destructive"
          : "grid h-full place-items-center px-6 text-center text-sm text-muted-foreground"
      }
    >
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
